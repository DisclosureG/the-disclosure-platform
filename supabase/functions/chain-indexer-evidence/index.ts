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
  "event ReviewVoteCast(bytes32 indexed id, address indexed voter, bool approve, uint32 approveCount, uint32 rejectCount)",
  "event EvidenceCanonized(bytes32 indexed id, uint48 canonAt, uint32 approveCount)",
  "event EvidenceExpelled(bytes32 indexed id, uint32 rejectCount)",
  "event EvidenceLapsed(bytes32 indexed id)",
  "event ChallengeOpened(bytes32 indexed id, address indexed challenger, uint48 challengedAt)",
  "event ChallengeVoteCast(bytes32 indexed id, address indexed voter, bool supportChallenge, uint32 challengeVotes, uint32 defenseVotes)",
  "event EvidenceDeprecated(bytes32 indexed id, uint32 challengeVotes)",
  "event EvidenceReaffirmed(bytes32 indexed id, uint32 defenseVotes)",
  "event PeerAdded(address indexed peer, string handle, uint256 activePeerCount)",
  "event PeerRemoved(address indexed peer, uint256 activePeerCount)",
  "event PeerNominated(address indexed nominee, string handle, address indexed nominatedBy, uint256 threshold)",
  "event PeerEndorsed(address indexed nominee, address indexed endorser, uint32 endorsements, uint256 threshold)",
  "event NomineeVerified(address indexed peer, string handle, uint256 activePeerCount)",
  "event RevocationMotioned(address indexed peer, address indexed by, uint256 threshold)",
  "event RevocationVoteCast(address indexed peer, address indexed voter, uint32 votes, uint256 threshold)",
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
      out.payload     = { tier: Number(args[1]), content_hash: (args[3] as string).toLowerCase() };
      break;
    case "ReviewVoteCast":
      out.evidence_id = bytes32ToUuid(args[0] as string);
      out.peer_addr   = (args[1] as string).toLowerCase();
      out.payload     = {
        approve:       args[2] as boolean,
        approve_count: Number(args[3]),
        reject_count:  Number(args[4]),
      };
      break;
    case "EvidenceCanonized":
      out.evidence_id = bytes32ToUuid(args[0] as string);
      out.payload     = { canon_at: Number(args[1]), approve_count: Number(args[2]) };
      break;
    case "EvidenceExpelled":
      out.evidence_id = bytes32ToUuid(args[0] as string);
      out.payload     = { reject_count: Number(args[1]) };
      break;
    case "EvidenceLapsed":
      out.evidence_id = bytes32ToUuid(args[0] as string);
      break;
    case "ChallengeOpened":
      out.evidence_id = bytes32ToUuid(args[0] as string);
      out.peer_addr   = (args[1] as string).toLowerCase();
      out.payload     = { challenged_at: Number(args[2]) };
      break;
    case "ChallengeVoteCast":
      out.evidence_id = bytes32ToUuid(args[0] as string);
      out.peer_addr   = (args[1] as string).toLowerCase();
      out.payload     = {
        support_challenge: args[2] as boolean,
        challenge_votes:   Number(args[3]),
        defense_votes:     Number(args[4]),
      };
      break;
    case "EvidenceDeprecated":
      out.evidence_id = bytes32ToUuid(args[0] as string);
      out.payload     = { challenge_votes: Number(args[1]) };
      break;
    case "EvidenceReaffirmed":
      out.evidence_id = bytes32ToUuid(args[0] as string);
      out.payload     = { defense_votes: Number(args[1]) };
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

  while (from <= scanUntil) {
    const to = Math.min(from + MAX_RANGE - 1, scanUntil);
    let logs;
    try {
      logs = await provider.getLogs({ address: CONTRACT_ADDR, fromBlock: from, toBlock: to });
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
        await supabase.from("attestations").upsert(
          {
            evidence_id: decoded.evidence_id,
            peer_addr:   decoded.peer_addr,
            phase,
            verdict,
            tx_hash:     log.transactionHash,
            created_at:  occurred,
          },
          { onConflict: "evidence_id,peer_addr,phase", ignoreDuplicates: true },
        );
      }

      // Reconcile evidence.submitted_onchain when an EvidenceSubmitted lands.
      // Also write the content_hash so the off-chain row is bound to the
      // chain's view from indexer-side too.
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
      if (parsed.name === "EvidenceCanonized" && decoded.evidence_id) {
        const { error: e } = await supabase.from("evidence")
          .update({
            status:      "canon",
            canon_at:    occurred,
            reviewed_at: occurred,
          })
          .eq("id", decoded.evidence_id)
          .in("status", ["pending"]);
        if (!e) reconciled++;
      } else if (parsed.name === "EvidenceExpelled" && decoded.evidence_id) {
        const { error: e } = await supabase.from("evidence")
          .update({
            status:      "expelled",
            reviewed_at: occurred,
          })
          .eq("id", decoded.evidence_id)
          .in("status", ["pending"]);
        if (!e) reconciled++;
      } else if (parsed.name === "EvidenceLapsed" && decoded.evidence_id) {
        const { error: e } = await supabase.from("evidence")
          .update({ status: "lapsed" })
          .eq("id", decoded.evidence_id)
          .in("status", ["pending"]);
        if (!e) reconciled++;
      } else if (parsed.name === "ChallengeOpened" && decoded.evidence_id) {
        // Deliberate carve-out from the v4 "indexer never writes counts" rule:
        // openChallenge() on the contract explicitly resets r.challengeVotes=1
        // and r.defenseVotes=0 (see EvidenceConsensus.sol::openChallenge).  The
        // attestation_count_sync trigger only INCREMENTS, so without this
        // reset a re-contest (canon → contested → reaffirmed → contested)
        // would inherit cycle-1's accumulated counters and the first cycle-2
        // attestation could push challenge_votes over the deprecation
        // threshold off-chain without any matching chain transition.  Reset
        // to (1, 0) mirrors the chain's post-openChallenge state — the
        // opener's vote counts immediately.
        const { error: e } = await supabase.from("evidence")
          .update({
            status:          "contested",
            challenged_at:   occurred,
            challenge_votes: 1,
            defense_votes:   0,
          })
          .eq("id", decoded.evidence_id)
          .in("status", ["canon", "approved", "reaffirmed"]);
        if (!e) reconciled++;
      } else if (parsed.name === "EvidenceDeprecated" && decoded.evidence_id) {
        const { error: e } = await supabase.from("evidence")
          .update({
            status:        "deprecated",
            deprecated_at: occurred,
          })
          .eq("id", decoded.evidence_id)
          .in("status", ["contested"]);
        if (!e) reconciled++;
      } else if (parsed.name === "EvidenceReaffirmed" && decoded.evidence_id) {
        const { error: e } = await supabase.from("evidence")
          .update({ status: "reaffirmed" })
          .eq("id", decoded.evidence_id)
          .in("status", ["contested"]);
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
