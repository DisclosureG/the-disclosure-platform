// Tamper detection for canonized behaviour records.
//
// Two independent checks run per row, and either failure opens an alert:
//
//   1. payload → column. Re-derive (model_hash, input_hash, output_hash)
//      from the stored model_name/version + input_payload + output_payload
//      using the same canonical-JSON keccak the frontend uses at registration.
//      A drift here means the readable payload no longer matches the cached
//      hash — i.e. someone edited the content rows after canonisation. This
//      is the parity check with audit-content-hash on the evidence side.
//
//   2. column → chain. Read the on-chain BehaviourRecord struct via
//      `records(bytes32)` and compare each hash to the stored column. A
//      drift here means someone mutated the hash columns directly without
//      touching the chain. The chain is the source of truth at submission;
//      the column is a cache.
//
// Together the two checks form a transitive integrity claim: payload =
// column = chain. When all three agree the row is clean. When any pair
// disagrees we file an alert with the two values most informative for
// debugging (chain-vs-column drift takes precedence when both fire).
//
// Scheduled daily at 03:23 UTC by 20260518000900_behaviour_indexer_schedule.sql.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

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

const BEHAVIOUR_ADDR = Deno.env.get("BEHAVIOUR_CONSENSUS_ADDR") ?? null;
const RPC_URL        = Deno.env.get("BEHAVIOUR_CONSENSUS_RPC_URL")
                    ?? Deno.env.get("CONSENSUS_RPC_URL")
                    ?? "https://data-seed-prebsc-1-s1.binance.org:8545/";

const BEHAVIOUR_ABI = [
  "function records(bytes32 id) view returns (" +
    "uint8 state, uint8 tier, uint8 domain, " +
    "uint32 approveCount, uint32 rejectCount, uint32 challengeVotes, uint32 defenseVotes, " +
    "uint48 submittedAt, uint48 canonAt, uint48 challengedAt, " +
    "bytes32 modelHash, bytes32 inputHash, bytes32 outputHash, bytes32 challengerFirst)",
];

function uuidToBytes32(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  return "0x" + hex.padStart(64, "0");
}

// Recursive object-key sort. Hashing the canonicalised form makes the digest
// stable across Postgres jsonb round-trips (jsonb does not preserve key
// order). Mirrors canonicaliseJson in src/lib/wallet-impl.js and in
// verify-attestation-behaviour. Changing this rule changes every hash, so
// the three implementations must move together.
function canonicaliseJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicaliseJson);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicaliseJson(obj[key]);
  }
  return out;
}

function computeBehaviourModelHash(row: {
  model_name:    string | null;
  model_version: string | null;
}): string {
  const canon = JSON.stringify(canonicaliseJson({
    model_name:    String(row.model_name    ?? "").trim(),
    model_version: String(row.model_version ?? "").trim(),
  }));
  return ethers.keccak256(ethers.toUtf8Bytes(canon)).toLowerCase();
}

function computeBehaviourPayloadHash(payload: unknown): string {
  const canon = JSON.stringify(canonicaliseJson(payload ?? null));
  return ethers.keccak256(ethers.toUtf8Bytes(canon)).toLowerCase();
}

type BhRow = {
  id:             string;
  model_name:     string | null;
  model_version:  string | null;
  input_payload:  unknown;
  output_payload: unknown;
  model_hash:     string;
  input_hash:     string;
  output_hash:    string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  await supabase.from("edge_function_heartbeat").upsert(
    { function_name: "audit-behaviour-hash", last_attempt: new Date().toISOString(), last_status: "running" },
    { onConflict: "function_name" },
  );

  if (!BEHAVIOUR_ADDR) {
    return json({ error: "BEHAVIOUR_CONSENSUS_ADDR not configured" }, 500);
  }

  let provider: ethers.JsonRpcProvider;
  let contract: ethers.Contract;
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    contract = new ethers.Contract(BEHAVIOUR_ADDR, BEHAVIOUR_ABI, provider);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from("edge_function_heartbeat").upsert(
      { function_name: "audit-behaviour-hash", last_attempt: new Date().toISOString(), last_status: "error", last_payload: { stage: "rpc_init", error: msg } },
      { onConflict: "function_name" },
    );
    return json({ error: `RPC init failed: ${msg}` }, 503);
  }

  const PAGE          = 200;
  const RUN_BUDGET_MS = 50_000;
  const startedAtMs   = Date.now();

  let scanned        = 0;
  let alerts         = 0;
  let cleared        = 0;
  let budgetExceeded = false;
  let lastIdSeen: string | null = null;

  const { data: prev } = await supabase
    .from("edge_function_heartbeat")
    .select("last_payload")
    .eq("function_name", "audit-behaviour-hash")
    .maybeSingle();
  let resumeFromId: string | null =
    (prev?.last_payload as { resume_from_id?: string | null } | null)?.resume_from_id ?? null;

  while (true) {
    if (Date.now() - startedAtMs > RUN_BUDGET_MS) {
      budgetExceeded = true;
      break;
    }

    let q = supabase
      .from("behaviour")
      .select("id, model_name, model_version, input_payload, output_payload, model_hash, input_hash, output_hash")
      .eq("submitted_onchain", true)
      .not("model_hash",  "is", null)
      .not("input_hash",  "is", null)
      .not("output_hash", "is", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (resumeFromId) q = q.gt("id", resumeFromId);

    const { data, error } = await q;
    if (error) {
      await supabase.from("edge_function_heartbeat").upsert(
        { function_name: "audit-behaviour-hash", last_attempt: new Date().toISOString(), last_status: "error",
          last_payload: { error: error.message, scanned, alerts, resume_from_id: resumeFromId } },
        { onConflict: "function_name" },
      );
      return json({ error: error.message, scanned, alerts, resume_from_id: resumeFromId }, 500);
    }

    const rows = (data ?? []) as BhRow[];
    if (rows.length === 0) {
      resumeFromId = null;
      break;
    }

    // Read on-chain records for the page in parallel — small enough page that
    // we don't worry about RPC fan-out limits, large enough that latency is
    // amortised.
    const onChain = await Promise.all(rows.map(async (row) => {
      try {
        const r = await contract.records(uuidToBytes32(row.id));
        return {
          id:         row.id,
          modelHash:  String(r.modelHash).toLowerCase(),
          inputHash:  String(r.inputHash).toLowerCase(),
          outputHash: String(r.outputHash).toLowerCase(),
        };
      } catch {
        return null;
      }
    }));

    const driftedIds: string[] = [];
    const cleanIds:   string[] = [];
    const expectedByDriftedId = new Map<string, { expected: string; stored: string }>();

    for (let i = 0; i < rows.length; i++) {
      scanned++;
      const row = rows[i];
      lastIdSeen = row.id;
      const oc = onChain[i];
      if (!oc) continue; // record missing on-chain — likely indexer lag; skip without alert

      const storedTriple = `${row.model_hash}|${row.input_hash}|${row.output_hash}`.toLowerCase();
      const chainTriple  = `${oc.modelHash}|${oc.inputHash}|${oc.outputHash}`.toLowerCase();

      const derivedTriple = [
        computeBehaviourModelHash(row),
        computeBehaviourPayloadHash(row.input_payload),
        computeBehaviourPayloadHash(row.output_payload),
      ].join("|");

      // Three-way agreement = clean. Either failure files an alert.
      // Column-vs-chain drift takes precedence in the message because it
      // points at the cache having diverged from the immutable record.
      if (storedTriple !== chainTriple) {
        driftedIds.push(row.id);
        expectedByDriftedId.set(row.id, { expected: chainTriple, stored: storedTriple });
      } else if (derivedTriple !== storedTriple) {
        driftedIds.push(row.id);
        expectedByDriftedId.set(row.id, { expected: derivedTriple, stored: storedTriple });
      } else {
        cleanIds.push(row.id);
      }
    }

    const allIds = [...driftedIds, ...cleanIds];
    const openByBehaviour = new Set<string>();
    if (allIds.length > 0) {
      const { data: openRows } = await supabase
        .from("behaviour_tamper_alerts")
        .select("behaviour_id")
        .in("behaviour_id", allIds)
        .is("resolved_at", null);
      for (const r of (openRows ?? []) as { behaviour_id: string }[]) {
        openByBehaviour.add(r.behaviour_id);
      }
    }

    const newAlerts = driftedIds
      .filter(id => !openByBehaviour.has(id))
      .map(id => {
        const e = expectedByDriftedId.get(id)!;
        return { behaviour_id: id, expected_hash: e.expected, stored_hash: e.stored };
      });
    if (newAlerts.length > 0) {
      await supabase.from("behaviour_tamper_alerts").insert(newAlerts);
      alerts += newAlerts.length;
    }

    const idsToResolve = cleanIds.filter(id => openByBehaviour.has(id));
    if (idsToResolve.length > 0) {
      await supabase
        .from("behaviour_tamper_alerts")
        .update({ resolved_at: new Date().toISOString(), resolution_note: "auto: hashes matched on re-audit" })
        .in("behaviour_id", idsToResolve)
        .is("resolved_at", null);
      cleared += idsToResolve.length;
    }

    resumeFromId = lastIdSeen;
    if (rows.length < PAGE) {
      resumeFromId = null;
      break;
    }
  }

  const payload = {
    ok:                   true,
    scanned,
    alerts_opened:        alerts,
    alerts_cleared:       cleared,
    time_budget_exceeded: budgetExceeded,
    resume_from_id:       resumeFromId,
  };
  await supabase.from("edge_function_heartbeat").upsert(
    { function_name: "audit-behaviour-hash", last_attempt: new Date().toISOString(),
      last_success: new Date().toISOString(), last_status: "ok", last_payload: payload },
    { onConflict: "function_name" },
  );

  return json(payload);
});
