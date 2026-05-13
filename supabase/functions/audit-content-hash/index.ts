// Tamper detection for canonized evidence.
//
// For every row with submitted_onchain = true and a non-null content_hash,
// recompute keccak256(canonical_payload) using the same rule the frontend and
// verify-attestation share.  If the stored hash diverges, write a row into
// public.tamper_alerts so an operator gets visibility.
//
// Scheduled daily by pg_cron via 20260514002400_tamper_alerts.sql.  Idempotent:
// open alerts on the same evidence_id are de-duplicated by (evidence_id,
// resolved_at IS NULL) so a flapping row only opens one alert.

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

function computeContentHash(payload: {
  title:     string;
  source:    string | null;
  year:      string | null;
  excerpt:   string | null;
  link:      string | null;
  tier:      number;
  pillar_id: string;
}): string {
  const canon = JSON.stringify({
    title:     String(payload.title ?? "").trim(),
    source:    String(payload.source ?? "").trim(),
    year:      String(payload.year ?? "").trim(),
    excerpt:   String(payload.excerpt ?? "").trim(),
    link:      String(payload.link ?? "").trim(),
    tier:      Number(payload.tier),
    pillar_id: String(payload.pillar_id ?? "").trim(),
  });
  return ethers.keccak256(ethers.toUtf8Bytes(canon)).toLowerCase();
}

type EvRow = {
  id:           string;
  title:        string;
  source:       string | null;
  year:         string | null;
  excerpt:      string | null;
  link:         string | null;
  tier:         number;
  pillar_id:    string;
  content_hash: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  await supabase.from("edge_function_heartbeat").upsert(
    { function_name: "audit-content-hash", last_attempt: new Date().toISOString(), last_status: "running" },
    { onConflict: "function_name" },
  );

  // Page through evidence in batches so very large archives don't blow memory.
  const PAGE = 500;
  // Hard time budget — the edge runtime caps a single invocation at ~60s.
  // Stop scanning ~10s before the cap so we always get to write a success
  // heartbeat instead of dying silently mid-loop.  Next cron tick picks up
  // where we stopped via `resumeFromId`.
  const RUN_BUDGET_MS = 50_000;
  const startedAtMs   = Date.now();

  let scanned        = 0;
  let alerts         = 0;
  let cleared        = 0;
  let budgetExceeded = false;
  let lastIdSeen: string | null = null;

  // Resume cursor: persist the last evidence id we successfully audited so a
  // multi-tick scan can finish without re-doing work.  Stored as a row in
  // edge_function_heartbeat.last_payload.resume_from_id.
  const { data: prev } = await supabase
    .from("edge_function_heartbeat")
    .select("last_payload")
    .eq("function_name", "audit-content-hash")
    .maybeSingle();
  let resumeFromId: string | null =
    (prev?.last_payload as { resume_from_id?: string | null } | null)?.resume_from_id ?? null;

  while (true) {
    if (Date.now() - startedAtMs > RUN_BUDGET_MS) {
      budgetExceeded = true;
      break;
    }

    let q = supabase
      .from("evidence")
      .select("id, title, source, year, excerpt, link, tier, pillar_id, content_hash")
      .eq("submitted_onchain", true)
      .not("content_hash", "is", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (resumeFromId) q = q.gt("id", resumeFromId);

    const { data, error } = await q;

    if (error) {
      // Preserve resume_from_id on error so the next cron tick picks up
      // where this run stopped instead of rescanning from the top of
      // evidence.  Without this, a single transient Postgres / network
      // hiccup mid-page wipes hours of multi-tick progress at 1 M+ rows.
      await supabase.from("edge_function_heartbeat").upsert(
        {
          function_name: "audit-content-hash",
          last_attempt:  new Date().toISOString(),
          last_status:   "error",
          last_payload:  {
            error:          error.message,
            scanned,
            alerts,
            resume_from_id: resumeFromId,
          },
        },
        { onConflict: "function_name" },
      );
      return json({ error: error.message, scanned, alerts, resume_from_id: resumeFromId }, 500);
    }

    const rows = (data ?? []) as EvRow[];
    if (rows.length === 0) {
      // Full scan complete — clear the resume cursor so next run starts fresh.
      resumeFromId = null;
      break;
    }

    // Compute expected hashes for the whole page upfront, partition into
    // drifted vs clean, then issue ONE batched lookup against tamper_alerts
    // instead of two per row.  Cuts REST traffic from O(rows) → O(1) per page.
    const driftedIds: string[] = [];
    const cleanIds:   string[] = [];
    const expectedByDriftedId = new Map<string, { expected: string; stored: string }>();
    for (const row of rows) {
      scanned++;
      lastIdSeen     = row.id;
      const expected = computeContentHash(row);
      const stored   = (row.content_hash ?? "").toLowerCase();
      if (expected !== stored) {
        driftedIds.push(row.id);
        expectedByDriftedId.set(row.id, { expected, stored });
      } else {
        cleanIds.push(row.id);
      }
    }

    // Single batched lookup for open alerts across the whole page.
    const allIds = [...driftedIds, ...cleanIds];
    const openByEvidence = new Set<string>();
    if (allIds.length > 0) {
      const { data: openRows } = await supabase
        .from("tamper_alerts")
        .select("evidence_id")
        .in("evidence_id", allIds)
        .is("resolved_at", null);
      for (const r of (openRows ?? []) as { evidence_id: string }[]) {
        openByEvidence.add(r.evidence_id);
      }
    }

    // Insert new alerts only for drifted rows that don't already have one open.
    const newAlerts = driftedIds
      .filter(id => !openByEvidence.has(id))
      .map(id => {
        const e = expectedByDriftedId.get(id)!;
        return { evidence_id: id, expected_hash: e.expected, stored_hash: e.stored };
      });
    if (newAlerts.length > 0) {
      await supabase.from("tamper_alerts").insert(newAlerts);
      alerts += newAlerts.length;
    }

    // Auto-resolve open alerts for clean rows.
    const idsToResolve = cleanIds.filter(id => openByEvidence.has(id));
    if (idsToResolve.length > 0) {
      await supabase
        .from("tamper_alerts")
        .update({ resolved_at: new Date().toISOString(), resolution_note: "auto: hash matched on re-audit" })
        .in("evidence_id", idsToResolve)
        .is("resolved_at", null);
      cleared += idsToResolve.length;
    }

    resumeFromId = lastIdSeen;
    if (rows.length < PAGE) {
      // End of table — clear cursor so next run starts fresh.
      resumeFromId = null;
      break;
    }
  }

  const payload = {
    ok:                  true,
    scanned,
    alerts_opened:       alerts,
    alerts_cleared:      cleared,
    time_budget_exceeded: budgetExceeded,
    resume_from_id:      resumeFromId,
  };
  await supabase.from("edge_function_heartbeat").upsert(
    {
      function_name: "audit-content-hash",
      last_attempt:  new Date().toISOString(),
      last_success:  new Date().toISOString(),
      last_status:   "ok",
      last_payload:  payload,
    },
    { onConflict: "function_name" },
  );

  return json(payload);
});
