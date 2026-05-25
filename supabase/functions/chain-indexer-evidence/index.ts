// Chain indexer for EvidenceConsensus.
//
// Polls eth_getLogs from the last processed block, decodes events through
// the contract ABI, projects (evidence_id, peer_addr, payload) and upserts
// into public.chain_events.  Also reconciles two side-effects:
//   - sets evidence.submitted_onchain = true when an EvidenceSubmitted event
//     for a known UUID lands;
//   - records each successful state-changing event for the public feed.
//
// Scheduled by pg_cron + pg_net (see 20260514001400_indexer_schedule.sql).
// Manual invocations are allowed; the cursor table guarantees idempotency.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

const CONTRACT_ADDR = Deno.env.get("CONSENSUS_ADDR") ?? null;
// The peer nominee / revocation governance moved to a separate PeerGovernance
// contract at its own address.  Peer-membership events (PeerNominated,
// PeerEndorsed, NomineeVerified, NomineeLapsed, RevocationMotioned,
// RevocationVoteCast, RevocationCancelled, PeerRevoked) are now emitted there;
// everything else — including PeerAdded / PeerRemoved — stays on the core.  We
// scan BOTH addresses in one eth_getLogs (address array), and since each event's
// topic0 is unique the merged ABI parses logs from whichever contract emitted.
const GOVERNANCE_ADDR = Deno.env.get("GOVERNANCE_ADDR") ?? null;
const RPC_URL       = Deno.env.get("CONSENSUS_RPC_URL") ?? "https://data-seed-prebsc-1-s1.binance.org:8545/";
const MAX_RANGE     = 4_000; // BSC public RPCs cap eth_getLogs ranges
const CONFIRMATIONS = Number(Deno.env.get("INDEXER_CONFIRMATIONS") ?? 12);

// Hard cap on blocks scanned per run so a long outage cannot blow up a single
// invocation. ~50k blocks ≈ 42 hours of BSC at 3s/block — comfortable headroom
// for a one-minute cron without risking a 60-second function timeout on a
// degraded RPC. The remainder is picked up by the next tick.
const MAX_BLOCKS_PER_RUN = Number(Deno.env.get("INDEXER_MAX_BLOCKS_PER_RUN") ?? 50_000);

const ABI = [
  "event EvidenceSubmitted(bytes32 indexed id, uint8 tier, address indexed submitter, bytes32 contentHash)",
  "event BindingSubmitted(bytes32 indexed bindingId, bytes32 indexed id, bytes32 indexed topicId, uint8 tier, address submitter)",
  "event BindingQueued(bytes32 indexed bindingId, bytes32 indexed id, bytes32 indexed topicId, uint8 tier, address submitter)",
  "event QueueBoosted(bytes32 indexed bindingId, address indexed supporter, uint32 queuePriority)",
  "event PillarProposed(bytes32 indexed id, bytes32 metaHash, address indexed proposedBy, uint256 threshold)",
  "event TopicProposed(bytes32 indexed id, bytes32 indexed parent, bytes32 metaHash, address indexed proposedBy, uint256 threshold)",
  "event NodeEndorsed(bytes32 indexed id, address indexed endorser, uint32 endorsements, uint256 threshold)",
  "event ProposalLapsed(bytes32 indexed id)",
  "event PillarRatified(bytes32 indexed id, bytes32 metaHash)",
  "event TopicRatified(bytes32 indexed id, bytes32 indexed parent, bytes32 metaHash)",
  "event NodeRetired(bytes32 indexed id, uint8 kind, bytes32 indexed parent)",
  "event ReviewVoteCast(bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, address indexed voter, bool approve, uint32 approveCount, uint32 rejectCount, bytes sig)",
  "event BindingCanonized(bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, uint48 canonAt, uint32 approveCount)",
  "event BindingExpelled(bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, uint32 rejectCount)",
  "event BindingLapsed(bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId)",
  "event ChallengeOpened(bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, address indexed challenger, uint48 challengedAt)",
  "event ChallengeVoteCast(bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, address indexed voter, bool supportChallenge, uint32 challengeVotes, uint32 defenseVotes, bytes sig)",
  "event BindingDeprecated(bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, uint32 challengeVotes)",
  "event BindingReaffirmed(bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, uint32 defenseVotes)",
  "event PeerAdded(address indexed peer, string handle, uint256 activePeerCount)",
  "event PeerRemoved(address indexed peer, uint256 activePeerCount)",
  "event PeerNominated(address indexed nominee, string handle, address indexed nominatedBy, uint256 threshold)",
  "event PeerEndorsed(address indexed nominee, address indexed endorser, uint32 endorsements, uint256 threshold)",
  "event NomineeVerified(address indexed peer, string handle, uint256 activePeerCount)",
  "event NomineeLapsed(address indexed nominee)",
  "event RevocationMotioned(address indexed peer, address indexed by, uint256 threshold)",
  "event RevocationVoteCast(address indexed peer, address indexed voter, uint32 votes, uint256 threshold)",
  "event RevocationCancelled(address indexed peer)",
  "event PeerRevoked(address indexed peer, uint256 activePeerCount)",
  "event Paused(address indexed by)",
  "event Unpaused(address indexed by)",
];

const IFACE = new ethers.Interface(ABI);

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function bytes32ToUuid(hex32: string): string {
  const h = hex32.replace(/^0x/, "").replace(/^0+/, "").padStart(32, "0");
  return [h.slice(0,8), h.slice(8,12), h.slice(12,16), h.slice(16,20), h.slice(20)].join("-");
}

// Resolve an off-chain binding row id + topic from a decoded vote event's
// binding_hash (the on-chain bindingId). Returns null if the binding hasn't been
// projected yet (BindingSubmitted not indexed) — the backfill is then skipped.
async function resolveBindingId(
  supabase: ReturnType<typeof createClient>,
  decoded:  { payload: Record<string, unknown> },
): Promise<{ id: string; topic_id: string } | null> {
  const bHash = (decoded.payload as { binding_hash?: string }).binding_hash ?? null;
  if (!bHash) return null;
  const { data } = await supabase
    .from("bindings").select("id, topic_id").eq("binding_hash", bHash).maybeSingle();
  return (data as { id: string; topic_id: string } | null) ?? null;
}

// Resolve a peer's human handle from already-indexed PeerAdded / NomineeVerified
// events so an indexer-backfilled (tx-proof) attestation still carries the peer
// name — vote history must always be able to show who voted, not a bare address.
// A voter is necessarily a peer, so their add event sits in an earlier block and
// is already in chain_events by the time their vote is processed. Cached per run;
// null if the add event hasn't been indexed yet (UI then falls back to the addr).
async function resolvePeerHandle(
  supabase: ReturnType<typeof createClient>,
  addr:     string,
  cache:    Map<string, string | null>,
): Promise<string | null> {
  const key = addr.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  const { data } = await supabase
    .from("chain_events")
    .select("payload")
    .in("event_name", ["PeerAdded", "NomineeVerified"])
    .eq("peer_addr", key)
    .order("block_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const handle = (data as { payload?: { handle?: string } } | null)?.payload?.handle ?? null;
  cache.set(key, handle);
  return handle;
}

// Garbage-collect the pending founding evidence + binding placeholders under a
// set of topics whose proposal lapsed.  These were inserted off-chain when the
// node was proposed but were never submitted on-chain (an un-ratified topic
// can't accept on-chain evidence), so flipping the pending/not-on-chain rows to
// 'lapsed' is safe and idempotent.
async function lapseFoundingBundle(
  supabase: ReturnType<typeof createClient>,
  topicIds: string[],
): Promise<void> {
  if (!topicIds.length) return;
  await supabase.from("bindings").update({ status: "lapsed" })
    .in("topic_id", topicIds).eq("status", "pending").eq("submitted_onchain", false);
  await supabase.from("evidence").update({ status: "lapsed" })
    .in("topic_id", topicIds).eq("status", "pending").eq("submitted_onchain", false);
}

type Decoded = {
  evidence_id: string | null;
  peer_addr:   string | null;
  payload:     Record<string, unknown>;
};

function project(name: string, args: ethers.Result): Decoded {
  const out: Decoded = { evidence_id: null, peer_addr: null, payload: {} };
  switch (name) {
    case "EvidenceSubmitted":
      out.evidence_id = bytes32ToUuid(args[0] as string);
      out.peer_addr   = (args[2] as string).toLowerCase();
      out.payload     = {
        tier:         Number(args[1]),
        content_hash: (args[3] as string).toLowerCase(),
      };
      break;
    case "BindingSubmitted":
    case "BindingQueued":
      out.evidence_id = bytes32ToUuid(args[1] as string);
      out.peer_addr   = (args[4] as string).toLowerCase();
      out.payload     = {
        binding_hash: (args[0] as string).toLowerCase(),
        topic_hash:   (args[2] as string).toLowerCase(),
        tier:         Number(args[3]),
      };
      break;
    case "QueueBoosted":
      out.peer_addr = (args[1] as string).toLowerCase();
      out.payload   = {
        binding_hash:   (args[0] as string).toLowerCase(),
        supporter:      (args[1] as string).toLowerCase(),
        queue_priority: Number(args[2]),
      };
      break;
    case "PillarProposed":
      out.peer_addr = (args[2] as string).toLowerCase();
      out.payload   = { kind: "pillar", node_hash: (args[0] as string).toLowerCase(), meta_hash: (args[1] as string).toLowerCase(), threshold: Number(args[3]) };
      break;
    case "TopicProposed":
      out.peer_addr = (args[3] as string).toLowerCase();
      out.payload   = { kind: "topic", node_hash: (args[0] as string).toLowerCase(), parent: (args[1] as string).toLowerCase(), meta_hash: (args[2] as string).toLowerCase(), threshold: Number(args[4]) };
      break;
    case "NodeEndorsed":
      out.peer_addr = (args[1] as string).toLowerCase();
      out.payload   = { node_hash: (args[0] as string).toLowerCase(), endorser: (args[1] as string).toLowerCase(), endorsements: Number(args[2]), threshold: Number(args[3]) };
      break;
    case "ProposalLapsed":
      out.payload = { node_hash: (args[0] as string).toLowerCase() };
      break;
    case "RevocationCancelled":
    case "NomineeLapsed":
      out.peer_addr = (args[0] as string).toLowerCase();
      break;
    case "PillarRatified":
      out.payload = { kind: "pillar", node_hash: (args[0] as string).toLowerCase(), meta_hash: (args[1] as string).toLowerCase() };
      break;
    case "TopicRatified":
      out.payload = { kind: "topic", node_hash: (args[0] as string).toLowerCase(), parent: (args[1] as string).toLowerCase(), meta_hash: (args[2] as string).toLowerCase() };
      break;
    case "NodeRetired":
      out.payload = { kind: Number(args[1]) === 0 ? "pillar" : "topic", node_hash: (args[0] as string).toLowerCase(), parent: (args[2] as string).toLowerCase() };
      break;
    case "ReviewVoteCast":
      out.evidence_id = bytes32ToUuid(args[1] as string);
      out.peer_addr   = (args[3] as string).toLowerCase();
      out.payload     = {
        binding_hash:  (args[0] as string).toLowerCase(),
        topic_hash:    (args[2] as string).toLowerCase(),
        approve:       args[4] as boolean,
        approve_count: Number(args[5]),
        reject_count:  Number(args[6]),
        // The voter's EIP-712 Vote signature, emitted by the contract so a
        // gap-filled attestation row carries the real signed proof.
        sig:           args[7] ? (args[7] as string) : null,
      };
      break;
    case "BindingCanonized":
      out.evidence_id = bytes32ToUuid(args[1] as string);
      out.payload     = { binding_hash: (args[0] as string).toLowerCase(), canon_at: Number(args[3]), approve_count: Number(args[4]) };
      break;
    case "BindingExpelled":
      out.evidence_id = bytes32ToUuid(args[1] as string);
      out.payload     = { binding_hash: (args[0] as string).toLowerCase(), reject_count: Number(args[3]) };
      break;
    case "BindingLapsed":
      out.evidence_id = bytes32ToUuid(args[1] as string);
      out.payload     = { binding_hash: (args[0] as string).toLowerCase() };
      break;
    case "ChallengeOpened":
      out.evidence_id = bytes32ToUuid(args[1] as string);
      out.peer_addr   = (args[3] as string).toLowerCase();
      out.payload     = { binding_hash: (args[0] as string).toLowerCase(), challenged_at: Number(args[4]) };
      break;
    case "ChallengeVoteCast":
      out.evidence_id = bytes32ToUuid(args[1] as string);
      out.peer_addr   = (args[3] as string).toLowerCase();
      out.payload     = {
        binding_hash:      (args[0] as string).toLowerCase(),
        support_challenge: args[4] as boolean,
        challenge_votes:   Number(args[5]),
        defense_votes:     Number(args[6]),
        // The voter's EIP-712 Vote signature, emitted by the contract so a
        // gap-filled attestation row carries the real signed proof.
        sig:               args[7] ? (args[7] as string) : null,
      };
      break;
    case "BindingDeprecated":
      out.evidence_id = bytes32ToUuid(args[1] as string);
      out.payload     = { binding_hash: (args[0] as string).toLowerCase(), challenge_votes: Number(args[3]) };
      break;
    case "BindingReaffirmed":
      out.evidence_id = bytes32ToUuid(args[1] as string);
      out.payload     = { binding_hash: (args[0] as string).toLowerCase(), defense_votes: Number(args[3]) };
      break;
    case "PeerAdded":
    case "NomineeVerified":
      out.peer_addr = (args[0] as string).toLowerCase();
      out.payload   = { handle: args[1] as string, active_peer_count: Number(args[2]) };
      break;
    case "PeerRemoved":
    case "PeerRevoked":
      out.peer_addr = (args[0] as string).toLowerCase();
      out.payload   = { active_peer_count: Number(args[1]) };
      break;
    case "PeerNominated":
      out.peer_addr = (args[0] as string).toLowerCase();
      out.payload   = { handle: args[1] as string, nominated_by: (args[2] as string).toLowerCase(), threshold: Number(args[3]) };
      break;
    case "PeerEndorsed":
      out.peer_addr = (args[0] as string).toLowerCase();
      out.payload   = { endorser: (args[1] as string).toLowerCase(), endorsements: Number(args[2]), threshold: Number(args[3]) };
      break;
    case "RevocationMotioned":
      out.peer_addr = (args[0] as string).toLowerCase();
      out.payload   = { by: (args[1] as string).toLowerCase(), threshold: Number(args[2]) };
      break;
    case "RevocationVoteCast":
      out.peer_addr = (args[0] as string).toLowerCase();
      out.payload   = { voter: (args[1] as string).toLowerCase(), votes: Number(args[2]), threshold: Number(args[3]) };
      break;
    case "Paused":
    case "Unpaused":
      out.peer_addr = (args[0] as string).toLowerCase();
      break;
  }
  return out;
}

async function writeHeartbeat(
  supabase: ReturnType<typeof createClient>,
  status:   "running" | "ok" | "error",
  payload:  Record<string, unknown> = {},
  markSuccess = false,
) {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    function_name: "chain-indexer-evidence",
    last_attempt:  now,
    last_status:   status,
    last_payload:  payload,
  };
  if (markSuccess) row.last_success = now;
  await supabase.from("edge_function_heartbeat").upsert(row, { onConflict: "function_name" });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!CONTRACT_ADDR) return json({ error: "CONSENSUS_ADDR not configured" }, 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  await writeHeartbeat(supabase, "running");

  let provider: ethers.JsonRpcProvider;
  let head:     number;
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    head     = await provider.getBlockNumber();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeHeartbeat(supabase, "error", { stage: "rpc_init", error: msg });
    return json({ error: `RPC unavailable: ${msg}` }, 503);
  }

  // Reorg buffer — never scan past head - CONFIRMATIONS.  BSC reorgs are
  // typically < 12 blocks; on mainnet 12 is comfortable.  Override via env.
  const safeHead = Math.max(0, head - CONFIRMATIONS);

  const { data: cursorRow } = await supabase
    .from("chain_event_cursor").select("last_block").eq("contract_addr", CONTRACT_ADDR).maybeSingle();

  const startFrom = cursorRow
    ? Number((cursorRow as { last_block: number }).last_block) + 1
    : Math.max(0, safeHead - MAX_BLOCKS_PER_RUN);

  if (startFrom > safeHead) {
    const noop = { ok: true, head, safe_head: safeHead, started_at: startFrom, last_processed: startFrom - 1, chunks: 0, logs_scanned: 0, inserted: 0, note: "nothing to scan yet (reorg buffer)" };
    await writeHeartbeat(supabase, "ok", noop, true);
    return json(noop);
  }

  // Bound the scan window per invocation. If the cursor has fallen far behind
  // the indexer catches up over multiple ticks instead of risking a timeout
  // (or rate-limit-driven failure) trying to drain it all in one run.
  const scanUntil = Math.min(safeHead, startFrom + MAX_BLOCKS_PER_RUN - 1);

  let from = startFrom;
  const scanned: number[] = [];
  let inserted = 0;
  let reconciled = 0;
  let lastProcessed = startFrom - 1;
  const handleCache = new Map<string, string | null>();

  while (from <= scanUntil) {
    const to = Math.min(from + MAX_RANGE - 1, scanUntil);
    let logs;
    try {
      // eth_getLogs accepts an address ARRAY, so a single call covers both the
      // core and the PeerGovernance contracts. Topic0 is unique per event, so
      // the merged Interface parses each log regardless of which one emitted it.
      const scanAddrs = [CONTRACT_ADDR, GOVERNANCE_ADDR].filter(Boolean) as string[];
      logs = await provider.getLogs({ address: scanAddrs, fromBlock: from, toBlock: to });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await writeHeartbeat(supabase, "error", {
        stage: "getLogs", from, to, last_processed: lastProcessed, inserted, error: msg,
      });
      return json({
        error: `getLogs failed at ${from}-${to}: ${msg}`,
        last_processed: lastProcessed,
        inserted,
      }, 503);
    }
    scanned.push(logs.length);

    // Batch getBlock by unique block number — was N+1 before, now O(unique blocks).
    const uniqueBlocks = Array.from(new Set(logs.map(l => l.blockNumber)));
    const blockTsMap = new Map<number, string | null>();
    await Promise.all(uniqueBlocks.map(async (bn) => {
      try {
        const block = await provider.getBlock(bn);
        blockTsMap.set(bn, block ? new Date(Number(block.timestamp) * 1000).toISOString() : null);
      } catch {
        blockTsMap.set(bn, null);
      }
    }));

    for (const log of logs) {
      let parsed: ethers.LogDescription | null = null;
      try { parsed = IFACE.parseLog({ topics: [...log.topics], data: log.data }); }
      catch { continue; }
      if (!parsed) continue;

      const decoded  = project(parsed.name, parsed.args);
      const occurred = blockTsMap.get(log.blockNumber) ?? null;

      const { error } = await supabase.from("chain_events").upsert(
        {
          block_number: log.blockNumber,
          block_hash:   log.blockHash,
          tx_hash:      log.transactionHash,
          log_index:    log.index,
          event_name:   parsed.name,
          evidence_id:  decoded.evidence_id,
          peer_addr:    decoded.peer_addr,
          payload:      decoded.payload,
          occurred_at:  occurred,
        },
        { onConflict: "tx_hash,log_index", ignoreDuplicates: true },
      );
      if (!error) inserted++;

      // Backfill the off-chain attestation row from ReviewVoteCast /
      // ChallengeVoteCast.  The normal path is: client signs + broadcasts tx,
      // then calls verify-attestation which inserts the row.  If the client
      // closes the tab / loses network / hits a 5xx between mining and the
      // edge-function call, the vote lives on-chain but Supabase never gets
      // the row — and with quorum=1 a single lost insert is enough to flip
      // evidence.status to canon with zero attestations attached.  The chain
      // is the source of truth, so the indexer plugs the gap.  ON CONFLICT
      // DO NOTHING via (evidence_id, peer_addr, phase): if the edge function
      // already wrote the row, this is a no-op and the count trigger does
      // not fire a second time.
      if (
        (parsed.name === "ReviewVoteCast" || parsed.name === "ChallengeVoteCast") &&
        decoded.evidence_id && decoded.peer_addr
      ) {
        const phase   = parsed.name === "ReviewVoteCast" ? "review" : "challenge";
        const verdict = parsed.name === "ReviewVoteCast"
          ? ((decoded.payload as { approve?: boolean }).approve ? "approve" : "reject")
          : ((decoded.payload as { support_challenge?: boolean }).support_challenge ? "challenge" : "defend");
        const bid = await resolveBindingId(supabase, decoded);
        if (bid) {
          const handle = await resolvePeerHandle(supabase, decoded.peer_addr, handleCache);
          // The contract now emits the voter's EIP-712 Vote signature in the
          // event, so a gap-filled row can carry the real signed proof instead
          // of a bare tx proof. When a non-empty sig is present, store it with
          // proof_type 'eip712' (so a backfilled row is as strong as a client-
          // written one). Fall back to proof_type 'tx' (no eip712_sig) only when
          // the sig is empty/missing — defensive, for legacy/edge cases.
          // ignoreDuplicates still keeps this from downgrading a richer row the
          // edge function may have already written for the same binding/peer/phase.
          const emittedSig = (decoded.payload as { sig?: string | null }).sig ?? null;
          const hasSig     = typeof emittedSig === "string" && emittedSig.length > 2; // > "0x"
          await supabase.from("attestations").upsert(
            {
              evidence_id: decoded.evidence_id,
              binding_id:  bid.id,
              topic_id:    bid.topic_id,
              peer_addr:   decoded.peer_addr,
              peer_handle: handle,
              phase,
              verdict,
              tx_hash:     log.transactionHash,
              ...(hasSig
                ? { eip712_sig: emittedSig, proof_type: "eip712" }
                : { proof_type: "tx" }),
              created_at:  occurred,
            },
            { onConflict: "binding_id,peer_addr,phase", ignoreDuplicates: true },
          );
        }
      }

      // EvidenceSubmitted binds the canonical content (one hash per evidence).
      if (parsed.name === "EvidenceSubmitted" && decoded.evidence_id) {
        await supabase.from("evidence")
          .update({
            submitted_onchain:    true,
            submitted_onchain_at: occurred,
            submission_tx_hash:   log.transactionHash,
            content_hash:         (decoded.payload as { content_hash?: string }).content_hash ?? null,
          })
          .eq("id", decoded.evidence_id)
          .eq("submitted_onchain", false);
      }

      // BindingSubmitted / BindingQueued reconcile the (evidence × topic) binding
      // row: resolve the on-chain topic node_hash → slug + pillar, then bind the
      // row to chain.  A submission enters review immediately when a slot is free
      // (BindingSubmitted → status 'pending') or parks in the queue when the
      // active review set is full (BindingQueued → status 'queued').  A promoted
      // binding re-emits BindingSubmitted, so the same handler flips queued →
      // pending; a re-filed lapsed binding likewise returns to review.
      if ((parsed.name === "BindingSubmitted" || parsed.name === "BindingQueued") && decoded.evidence_id) {
        const queued = parsed.name === "BindingQueued";
        const p = decoded.payload as { binding_hash?: string; topic_hash?: string };
        let topicId: string | null = null, pillarId: string | null = null;
        if (p.topic_hash) {
          const { data: topic } = await supabase
            .from("topics").select("id, pillar_id").eq("node_hash", p.topic_hash).maybeSingle();
          if (topic) { topicId = (topic as { id: string }).id; pillarId = (topic as { pillar_id: string }).pillar_id; }
        }
        if (topicId) {
          const onchain: Record<string, unknown> = {
            binding_hash: p.binding_hash ?? null,
            submitted_onchain: true, submitted_onchain_at: occurred, submission_tx_hash: log.transactionHash,
          };
          if (queued) onchain.queued_at = occurred;
          // Update an existing off-chain binding, or insert one (chain-first path).
          const { data: existing } = await supabase
            .from("bindings").select("id, status").eq("evidence_id", decoded.evidence_id).eq("topic_id", topicId).maybeSingle();
          if (existing) {
            const cur = (existing as { status: string }).status;
            // Only (re)set the lifecycle status from a pre-review state, so a
            // late-arriving open/promote event can't undo a real verdict.
            if (queued) {
              if (cur === "pending" || cur === "lapsed") onchain.status = "queued";
            } else if (cur === "queued" || cur === "lapsed") {
              onchain.status = "pending";
            }
            await supabase.from("bindings").update(onchain).eq("id", (existing as { id: string }).id);
          } else {
            await supabase.from("bindings").insert({
              evidence_id: decoded.evidence_id, pillar_id: pillarId, topic_id: topicId,
              status: queued ? "queued" : "pending", ...onchain,
            });
          }
        }
      }

      // QueueBoosted raises a queued binding's public priority. The event carries
      // the authoritative running tally, so set it directly (idempotent re-runs
      // converge to the same value).
      if (parsed.name === "QueueBoosted") {
        const p = decoded.payload as { binding_hash?: string; queue_priority?: number };
        if (p.binding_hash) {
          await supabase.from("bindings")
            .update({ queue_priority: p.queue_priority ?? 0 })
            .eq("binding_hash", p.binding_hash);
        }
      }

      // ── Taxonomy reconciliation ─────────────────────────────────────────
      // The off-chain pillars/topics rows (with human metadata) are written by
      // the proposer's client before the on-chain call.  Here we project chain
      // state onto them keyed by node_hash: proposed → ratified, plus proposer /
      // tx bookkeeping.  Endorsements are read live from the contract by the UI,
      // so NodeEndorsed only lands in chain_events.
      if (parsed.name === "PillarProposed" || parsed.name === "TopicProposed") {
        const p = decoded.payload as { node_hash?: string; meta_hash?: string };
        const table = parsed.name === "PillarProposed" ? "pillars" : "topics";
        if (p.node_hash) {
          await supabase.from(table)
            .update({ proposed_by: decoded.peer_addr, propose_tx: log.transactionHash, meta_hash: p.meta_hash ?? null })
            .eq("node_hash", p.node_hash)
            .eq("status", "proposed");
        }
      } else if (parsed.name === "PillarRatified" || parsed.name === "TopicRatified") {
        const p = decoded.payload as { node_hash?: string };
        const table = parsed.name === "PillarRatified" ? "pillars" : "topics";
        if (p.node_hash) {
          const { error: e } = await supabase.from(table)
            .update({ status: "ratified" })
            .eq("node_hash", p.node_hash)
            .eq("status", "proposed");
          if (!e) reconciled++;
        }
      } else if (parsed.name === "NodeRetired") {
        // A ratified pillar/topic was retired by peer supermajority on-chain.
        const p = decoded.payload as { node_hash?: string; kind?: string };
        const table = p.kind === "pillar" ? "pillars" : "topics";
        if (p.node_hash) {
          const { error: e } = await supabase.from(table)
            .update({ status: "retired" })
            .eq("node_hash", p.node_hash)
            .eq("status", "ratified");
          if (!e) reconciled++;
        }
      } else if (parsed.name === "ProposalLapsed") {
        // A stalled proposal was garbage-collected on-chain.  The event carries
        // only the node id, so resolve whether it's a pillar or a topic and flip
        // the whole founding bundle to 'lapsed' (a pillar also carries a founding
        // topic; both carry a pending founding evidence + binding that were never
        // submitted on-chain).  Guards keep this idempotent.
        const p = decoded.payload as { node_hash?: string };
        if (p.node_hash) {
          const { data: pillarRow } = await supabase
            .from("pillars").select("id").eq("node_hash", p.node_hash).eq("status", "proposed").maybeSingle();
          if (pillarRow) {
            const pillarId = (pillarRow as { id: string }).id;
            const { data: topicRows } = await supabase
              .from("topics").select("id").eq("pillar_id", pillarId).eq("status", "proposed");
            await lapseFoundingBundle(supabase, (topicRows ?? []).map((t) => (t as { id: string }).id));
            await supabase.from("topics").update({ status: "lapsed" }).eq("pillar_id", pillarId).eq("status", "proposed");
            await supabase.from("pillars").update({ status: "lapsed" }).eq("id", pillarId).eq("status", "proposed");
            reconciled++;
          } else {
            const { data: topicRow } = await supabase
              .from("topics").select("id").eq("node_hash", p.node_hash).eq("status", "proposed").maybeSingle();
            if (topicRow) {
              const topicId = (topicRow as { id: string }).id;
              await lapseFoundingBundle(supabase, [topicId]);
              await supabase.from("topics").update({ status: "lapsed" }).eq("id", topicId).eq("status", "proposed");
              reconciled++;
            }
          }
        }
      }

      // ── Status reconciliation ────────────────────────────────────────────
      // The chain is the source of truth for evidence.status. The edge
      // function flips status as a fast-path optimisation, but if that
      // write fails (network, RPC, transient) the cache stays divergent
      // until the next vote arrives — or forever, for terminal events.
      // The indexer below projects every terminal state-changing event
      // straight from chain → cache. The `.in(status, [...])` guards keep
      // the operation idempotent across re-runs and prevent a stale event
      // from undoing a later transition (e.g. an old Canonized re-applied
      // after a Deprecated would be a no-op because status is no longer
      // 'pending').
      // NOTE: We deliberately do NOT write approve_count / reject_count /
      // challenge_votes / defense_votes from the chain event payload.  Those
      // columns are owned by the attestation_count_sync trigger
      // (20260514003000_materialize_attestation_counts.sql) which increments
      // them as off-chain attestations land.  Clobbering them here with the
      // chain snapshot (which is captured at threshold-crossing time, before
      // any later off-chain attestation) would lose every vote recorded
      // between canonization and reconciliation.  Status + timestamp only.
      // Status transitions land on the BINDING, located by its on-chain
      // binding_hash. The .in(status,[…]) guards keep this idempotent.
      const bHash = (decoded.payload as { binding_hash?: string }).binding_hash ?? null;
      if (parsed.name === "BindingCanonized" && bHash) {
        const { error: e } = await supabase.from("bindings")
          .update({ status: "canon", canon_at: occurred, reviewed_at: occurred })
          .eq("binding_hash", bHash).in("status", ["pending"]);
        if (!e) reconciled++;
      } else if (parsed.name === "BindingExpelled" && bHash) {
        const { error: e } = await supabase.from("bindings")
          .update({ status: "expelled", reviewed_at: occurred })
          .eq("binding_hash", bHash).in("status", ["pending"]);
        if (!e) reconciled++;
      } else if (parsed.name === "BindingLapsed" && bHash) {
        const { error: e } = await supabase.from("bindings")
          .update({ status: "lapsed" })
          .eq("binding_hash", bHash).in("status", ["pending"]);
        if (!e) reconciled++;
      } else if (parsed.name === "ChallengeOpened" && bHash) {
        // Mirror the contract's openChallenge reset (challengeVotes=1, defenseVotes=0).
        const { error: e } = await supabase.from("bindings")
          .update({ status: "contested", challenged_at: occurred, challenge_votes: 1, defense_votes: 0 })
          .eq("binding_hash", bHash).in("status", ["canon", "approved", "reaffirmed"]);
        if (!e) reconciled++;
      } else if (parsed.name === "BindingDeprecated" && bHash) {
        const { error: e } = await supabase.from("bindings")
          .update({ status: "deprecated", deprecated_at: occurred })
          .eq("binding_hash", bHash).in("status", ["contested"]);
        if (!e) reconciled++;
      } else if (parsed.name === "BindingReaffirmed" && bHash) {
        const { error: e } = await supabase.from("bindings")
          .update({ status: "reaffirmed" })
          .eq("binding_hash", bHash).in("status", ["contested"]);
        if (!e) reconciled++;
      }
    }

    lastProcessed = to;
    from = to + 1;

    // Advance the cursor after every successful chunk so a later RPC failure
    // doesn't force a full re-scan from the original start.  Chain events
    // are idempotent on (tx_hash, log_index), so an interrupted run resumes
    // from the last good block on the next tick instead of repeating
    // already-processed chunks.
    await supabase.from("chain_event_cursor").upsert({
      contract_addr: CONTRACT_ADDR,
      last_block:    lastProcessed,
      updated_at:    new Date().toISOString(),
    }, { onConflict: "contract_addr" });
  }

  const payload = {
    ok:             true,
    head,
    safe_head:      safeHead,
    scan_until:     scanUntil,
    started_at:     startFrom,
    last_processed: lastProcessed,
    chunks:         scanned.length,
    logs_scanned:   scanned.reduce((a, b) => a + b, 0),
    inserted,
    reconciled,
  };
  await writeHeartbeat(supabase, "ok", payload, true);
  return json(payload);
});
