// Chain indexer for BehaviourConsensus.
//
// Parallel to chain-indexer/index.ts but follows the alignment-side contract.
// Polls eth_getLogs from the last processed block, decodes BehaviourConsensus
// events via ABI, projects (behaviour_id, peer_addr, payload) and upserts
// into public.behaviour_chain_events.  Side-effects:
//   - sets behaviour.submitted_onchain = true when a BehaviourSubmitted event
//     for a known UUID lands;
//   - backfills behaviour_attestations on Review/Challenge vote events;
//   - reconciles behaviour.status on every terminal state-changing event.
//
// Scheduled by 20260518000900_behaviour_indexer_schedule.sql.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

const CONTRACT_ADDR = Deno.env.get("BEHAVIOUR_CONSENSUS_ADDR") ?? null;
const RPC_URL       = Deno.env.get("BEHAVIOUR_CONSENSUS_RPC_URL")
                   ?? Deno.env.get("CONSENSUS_RPC_URL")
                   ?? "https://data-seed-prebsc-1-s1.binance.org:8545/";
const MAX_RANGE     = 4_000;
const CONFIRMATIONS = Number(Deno.env.get("INDEXER_CONFIRMATIONS") ?? 12);
const MAX_BLOCKS_PER_RUN = Number(Deno.env.get("INDEXER_MAX_BLOCKS_PER_RUN") ?? 50_000);

const ABI = [
  "event BehaviourSubmitted(bytes32 indexed id, uint8 tier, uint8 domain, address indexed submitter, bytes32 modelHash, bytes32 inputHash, bytes32 outputHash)",
  "event ReviewVoteCast(bytes32 indexed id, address indexed voter, bool approve, uint32 approveCount, uint32 rejectCount)",
  "event BehaviourAligned(bytes32 indexed id, uint48 canonAt, uint32 approveCount)",
  "event BehaviourMisaligned(bytes32 indexed id, uint32 rejectCount)",
  "event BehaviourLapsed(bytes32 indexed id)",
  "event ChallengeOpened(bytes32 indexed id, address indexed challenger, uint48 challengedAt, string grounds)",
  "event ChallengeVoteCast(bytes32 indexed id, address indexed voter, bool supportChallenge, uint32 challengeVotes, uint32 defenseVotes)",
  "event BehaviourDeprecated(bytes32 indexed id, uint32 challengeVotes)",
  "event BehaviourReaffirmed(bytes32 indexed id, uint32 defenseVotes)",
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
  behaviour_id: string | null;
  peer_addr:    string | null;
  payload:      Record<string, unknown>;
};

function project(name: string, args: ethers.Result): Decoded {
  const out: Decoded = { behaviour_id: null, peer_addr: null, payload: {} };
  switch (name) {
    case "BehaviourSubmitted":
      out.behaviour_id = bytes32ToUuid(args[0] as string);
      out.peer_addr    = (args[3] as string).toLowerCase();
      out.payload      = {
        tier:        Number(args[1]),
        domain:      Number(args[2]),
        model_hash:  (args[4] as string).toLowerCase(),
        input_hash:  (args[5] as string).toLowerCase(),
        output_hash: (args[6] as string).toLowerCase(),
      };
      break;
    case "ReviewVoteCast":
      out.behaviour_id = bytes32ToUuid(args[0] as string);
      out.peer_addr    = (args[1] as string).toLowerCase();
      out.payload      = {
        approve:       args[2] as boolean,
        approve_count: Number(args[3]),
        reject_count:  Number(args[4]),
      };
      break;
    case "BehaviourAligned":
      out.behaviour_id = bytes32ToUuid(args[0] as string);
      out.payload      = { canon_at: Number(args[1]), approve_count: Number(args[2]) };
      break;
    case "BehaviourMisaligned":
      out.behaviour_id = bytes32ToUuid(args[0] as string);
      out.payload      = { reject_count: Number(args[1]) };
      break;
    case "BehaviourLapsed":
      out.behaviour_id = bytes32ToUuid(args[0] as string);
      break;
    case "ChallengeOpened":
      out.behaviour_id = bytes32ToUuid(args[0] as string);
      out.peer_addr    = (args[1] as string).toLowerCase();
      out.payload      = { challenged_at: Number(args[2]), grounds: args[3] as string };
      break;
    case "ChallengeVoteCast":
      out.behaviour_id = bytes32ToUuid(args[0] as string);
      out.peer_addr    = (args[1] as string).toLowerCase();
      out.payload      = {
        support_challenge: args[2] as boolean,
        challenge_votes:   Number(args[3]),
        defense_votes:     Number(args[4]),
      };
      break;
    case "BehaviourDeprecated":
      out.behaviour_id = bytes32ToUuid(args[0] as string);
      out.payload      = { challenge_votes: Number(args[1]) };
      break;
    case "BehaviourReaffirmed":
      out.behaviour_id = bytes32ToUuid(args[0] as string);
      out.payload      = { defense_votes: Number(args[1]) };
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
    function_name: "chain-indexer-behaviour",
    last_attempt:  now,
    last_status:   status,
    last_payload:  payload,
  };
  if (markSuccess) row.last_success = now;
  await supabase.from("edge_function_heartbeat").upsert(row, { onConflict: "function_name" });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!CONTRACT_ADDR) return json({ error: "BEHAVIOUR_CONSENSUS_ADDR not configured" }, 500);

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

  const safeHead = Math.max(0, head - CONFIRMATIONS);

  const { data: cursorRow } = await supabase
    .from("behaviour_chain_event_cursor")
    .select("last_block")
    .eq("contract_addr", CONTRACT_ADDR)
    .maybeSingle();

  const startFrom = cursorRow
    ? Number((cursorRow as { last_block: number }).last_block) + 1
    : Math.max(0, safeHead - MAX_BLOCKS_PER_RUN);

  if (startFrom > safeHead) {
    const noop = {
      ok: true, head, safe_head: safeHead, started_at: startFrom,
      last_processed: startFrom - 1, chunks: 0, logs_scanned: 0, inserted: 0,
      note: "nothing to scan yet (reorg buffer)",
    };
    await writeHeartbeat(supabase, "ok", noop, true);
    return json(noop);
  }

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

      const { error } = await supabase.from("behaviour_chain_events").upsert(
        {
          block_number: log.blockNumber,
          block_hash:   log.blockHash,
          tx_hash:      log.transactionHash,
          log_index:    log.index,
          event_name:   parsed.name,
          behaviour_id: decoded.behaviour_id,
          peer_addr:    decoded.peer_addr,
          payload:      decoded.payload,
          occurred_at:  occurred,
        },
        { onConflict: "tx_hash,log_index", ignoreDuplicates: true },
      );
      if (!error) inserted++;

      // Backfill behaviour_attestations from on-chain vote events. Identical
      // rationale to the evidence indexer: chain is source of truth; if the
      // verify-attestation-behaviour edge function call after broadcast
      // fails, the row would be missing without this recovery path.
      if (
        (parsed.name === "ReviewVoteCast" || parsed.name === "ChallengeVoteCast") &&
        decoded.behaviour_id && decoded.peer_addr
      ) {
        const phase   = parsed.name === "ReviewVoteCast" ? "review" : "challenge";
        const verdict = parsed.name === "ReviewVoteCast"
          ? ((decoded.payload as { approve?: boolean }).approve ? "approve" : "reject")
          : ((decoded.payload as { support_challenge?: boolean }).support_challenge ? "challenge" : "defend");
        await supabase.from("behaviour_attestations").upsert(
          {
            behaviour_id: decoded.behaviour_id,
            peer_addr:    decoded.peer_addr,
            phase,
            verdict,
            tx_hash:      log.transactionHash,
            created_at:   occurred,
          },
          { onConflict: "behaviour_id,peer_addr,phase", ignoreDuplicates: true },
        );
      }

      // Reconcile behaviour.submitted_onchain and write the three hashes.
      if (parsed.name === "BehaviourSubmitted" && decoded.behaviour_id) {
        const p = decoded.payload as {
          model_hash?: string; input_hash?: string; output_hash?: string;
        };
        await supabase.from("behaviour")
          .update({
            submitted_onchain:    true,
            submitted_onchain_at: occurred,
            submission_tx_hash:   log.transactionHash,
            model_hash:           p.model_hash  ?? null,
            input_hash:           p.input_hash  ?? null,
            output_hash:          p.output_hash ?? null,
          })
          .eq("id", decoded.behaviour_id)
          .eq("submitted_onchain", false);
      }

      // Status reconciliation: same shape as the evidence indexer. Status +
      // timestamp only; counters are owned by behaviour_attestation_count_sync.
      if (parsed.name === "BehaviourAligned" && decoded.behaviour_id) {
        const { error: e } = await supabase.from("behaviour")
          .update({ status: "aligned", canon_at: occurred, reviewed_at: occurred })
          .eq("id", decoded.behaviour_id)
          .in("status", ["pending"]);
        if (!e) reconciled++;
      } else if (parsed.name === "BehaviourMisaligned" && decoded.behaviour_id) {
        const { error: e } = await supabase.from("behaviour")
          .update({ status: "misaligned", reviewed_at: occurred })
          .eq("id", decoded.behaviour_id)
          .in("status", ["pending"]);
        if (!e) reconciled++;
      } else if (parsed.name === "BehaviourLapsed" && decoded.behaviour_id) {
        const { error: e } = await supabase.from("behaviour")
          .update({ status: "lapsed" })
          .eq("id", decoded.behaviour_id)
          .in("status", ["pending"]);
        if (!e) reconciled++;
      } else if (parsed.name === "ChallengeOpened" && decoded.behaviour_id) {
        // openChallenge() in the contract resets challengeVotes=1 / defenseVotes=0.
        // Mirror that here so re-contests don't inherit prior-cycle counters.
        // Also persist grounds into challenge_reason so the activity log can
        // render it later.
        const grounds = (decoded.payload as { grounds?: string }).grounds ?? null;
        const { error: e } = await supabase.from("behaviour")
          .update({
            status:           "contested",
            challenged_at:    occurred,
            challenge_votes:  1,
            defense_votes:    0,
            challenge_reason: grounds,
          })
          .eq("id", decoded.behaviour_id)
          .in("status", ["aligned", "reaffirmed"]);
        if (!e) reconciled++;
      } else if (parsed.name === "BehaviourDeprecated" && decoded.behaviour_id) {
        const { error: e } = await supabase.from("behaviour")
          .update({ status: "deprecated", deprecated_at: occurred })
          .eq("id", decoded.behaviour_id)
          .in("status", ["contested"]);
        if (!e) reconciled++;
      } else if (parsed.name === "BehaviourReaffirmed" && decoded.behaviour_id) {
        const { error: e } = await supabase.from("behaviour")
          .update({ status: "reaffirmed" })
          .eq("id", decoded.behaviour_id)
          .in("status", ["contested"]);
        if (!e) reconciled++;
      }
    }

    lastProcessed = to;
    from = to + 1;

    await supabase.from("behaviour_chain_event_cursor").upsert({
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
