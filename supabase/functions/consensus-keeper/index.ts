// Consensus keeper for EvidenceConsensus.
//
// Drives the two on-chain maintenance jobs that the contract cannot trigger
// itself, both PERMISSIONLESS and objectively gated on-chain (so this keeper's
// key grants no authority beyond what any address could already do):
//
//   1. Garbage-collect inactive peers — pruneInactivePeer(addr) for every active
//      peer idle past INACTIVITY_WINDOW, while staying above the seed-phase floor.
//   2. Promote queued evidence — promote(id, topicId) in public-priority order
//      (queue_priority desc, queued_at asc) until the active review set is full.
//
// Scheduled by pg_cron (see 20260523120000_queue_and_gc.sql). Manual invocations
// are allowed; both on-chain calls are idempotent (re-running is safe — a stale
// target simply reverts and is skipped).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

const CONTRACT_ADDR = Deno.env.get("CONSENSUS_ADDR") ?? null;
const RPC_URL       = Deno.env.get("CONSENSUS_RPC_URL") ?? "https://data-seed-prebsc-1-s1.binance.org:8545/";
const KEEPER_KEY    = Deno.env.get("KEEPER_PRIVATE_KEY") ?? null;

// Mirror the on-chain constant (internal in the contract for EIP-170 headroom).
const INACTIVITY_WINDOW_SECS = 30 * 24 * 60 * 60;

const ABI = [
  "function peerList() view returns (address[])",
  "function lastActive(address) view returns (uint48)",
  "function activePeerCount() view returns (uint256)",
  "function seedPhaseK() view returns (uint256)",
  "function reviewCapacity() view returns (uint256)",
  "function activeReviewCount() view returns (uint256)",
  "function pruneInactivePeer(address peer)",
  "function promote(bytes32 id, bytes32 topicId)",
];

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

// UUID → bytes32 (uuid's 16 bytes right-aligned, zero-padded to 32) — the same
// encoding the contract / wallet-impl use to link on-chain & off-chain ids.
function uuidToBytes32(uuid: string): string {
  return "0x" + uuid.replace(/-/g, "").padStart(64, "0");
}

async function writeHeartbeat(
  supabase: ReturnType<typeof createClient>,
  status:   "running" | "ok" | "error",
  payload:  Record<string, unknown> = {},
  markSuccess = false,
) {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    function_name: "consensus-keeper",
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
  if (!KEEPER_KEY)    return json({ error: "KEEPER_PRIVATE_KEY not configured" }, 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  await writeHeartbeat(supabase, "running");

  let provider: ethers.JsonRpcProvider;
  let signer:   ethers.Wallet;
  let core:     ethers.Contract;
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    signer   = new ethers.Wallet(KEEPER_KEY, provider);
    core     = new ethers.Contract(CONTRACT_ADDR, ABI, signer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeHeartbeat(supabase, "error", { stage: "init", error: msg });
    return json({ error: `keeper init failed: ${msg}` }, 503);
  }

  const pruned: string[] = [];
  const promoted: string[] = [];
  const errors: Array<{ stage: string; target: string; error: string }> = [];

  // ── 1. Prune inactive peers ───────────────────────────────────────────────
  try {
    const nowSecs   = Math.floor(Date.now() / 1000);
    const peers     = (await core.peerList()) as string[];
    const seedK     = Number(await core.seedPhaseK());
    let   activeCnt = Number(await core.activePeerCount());

    // Oldest-idle first, so when we hit the floor we keep the most-recently-active.
    const aged = await Promise.all(peers.map(async (addr) => ({
      addr, last: Number(await core.lastActive(addr)),
    })));
    aged.sort((a, b) => a.last - b.last);

    for (const { addr, last } of aged) {
      if (activeCnt <= seedK) break;                                  // peer floor
      if (nowSecs <= last + INACTIVITY_WINDOW_SECS) continue;          // still active
      try {
        const tx = await core.pruneInactivePeer(addr);
        await tx.wait();
        pruned.push(addr);
        activeCnt--;
      } catch (err: unknown) {
        errors.push({ stage: "prune", target: addr, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err: unknown) {
    errors.push({ stage: "prune_scan", target: "-", error: err instanceof Error ? err.message : String(err) });
  }

  // ── 2. Promote queued evidence in public-priority order ───────────────────
  try {
    const capacity = Number(await core.reviewCapacity());
    const active   = Number(await core.activeReviewCount());
    let   free     = Math.max(0, capacity - active);

    if (free > 0) {
      // Highest public priority first, then oldest-queued (FIFO).  Join topics for
      // the on-chain node_hash needed by promote(id, topicId).
      const { data: rows } = await supabase
        .from("bindings")
        .select("evidence_id, topic_id, binding_hash, topics(node_hash)")
        .eq("status", "queued")
        .order("queue_priority", { ascending: false })
        .order("queued_at", { ascending: true })
        .limit(free);

      for (const row of (rows ?? []) as Array<{ evidence_id: string; binding_hash: string | null; topics: { node_hash: string } | null }>) {
        if (free <= 0) break;
        const topicHash = row.topics?.node_hash ?? null;
        if (!topicHash) continue;
        try {
          const tx = await core.promote(uuidToBytes32(row.evidence_id), topicHash);
          await tx.wait();
          promoted.push(row.binding_hash ?? row.evidence_id);
          free--;
        } catch (err: unknown) {
          // A concurrent promotion / resolution can take the slot first; skip.
          errors.push({ stage: "promote", target: row.binding_hash ?? row.evidence_id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  } catch (err: unknown) {
    errors.push({ stage: "promote_scan", target: "-", error: err instanceof Error ? err.message : String(err) });
  }

  const payload = { ok: true, pruned, promoted, errors };
  await writeHeartbeat(supabase, errors.length ? "error" : "ok", payload, errors.length === 0);
  return json(payload);
});
