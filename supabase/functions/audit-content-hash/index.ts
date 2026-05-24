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

// Single service-role client factory. The node-audit helpers below take the
// client as a parameter, so they must share the EXACT client type the handler
// uses; deriving DB from this factory (which calls createClient with real
// arguments) keeps the schema generic as `any`. `ReturnType<typeof createClient>`
// with no inferred args would widen it to `never` and break .insert()/.update().
function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}
type DB = ReturnType<typeof serviceClient>;

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

// Binds the evidence CONTENT only — topic_id is intentionally excluded so a
// cross-listed record keeps one stable hash. Byte-identical with
// src/lib/wallet-impl.js and verify-attestation.
function computeContentHash(payload: {
  title:    string;
  source:   string | null;
  year:     string | null;
  excerpt:  string | null;
  link:     string | null;
  tier:     number;
}): string {
  const canon = JSON.stringify({
    title:   String(payload.title ?? "").trim(),
    source:  String(payload.source ?? "").trim(),
    year:    String(payload.year ?? "").trim(),
    excerpt: String(payload.excerpt ?? "").trim(),
    link:    String(payload.link ?? "").trim(),
    tier:    Number(payload.tier),
  });
  return ethers.keccak256(ethers.toUtf8Bytes(canon)).toLowerCase();
}

// On-chain taxonomy-node id = keccak256(utf8(slug)). Byte-identical with
// src/lib/wallet-impl.js slugToBytes32 and verify-attestation.
function slugToBytes32(slug: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(String(slug))).toLowerCase();
}

// Canonical taxonomy-node metadata hash. Byte-identical with
// src/lib/wallet-impl.js computeMetaHash — field order and trimming are part of
// the contract (the indexer joins on node_hash; peers commit meta_hash on-chain).
function computeMetaHash(node: {
  kind:   string;
  slug:   string;
  parent: string | null;
  title:  string;
  blurb:  string | null;
  tag:    string | null;
}): string {
  const canon = JSON.stringify({
    kind:   String(node.kind),
    slug:   String(node.slug ?? "").trim(),
    parent: String(node.parent ?? "").trim(),
    title:  String(node.title ?? "").trim(),
    blurb:  String(node.blurb ?? "").trim(),
    tag:    String(node.tag ?? "").trim(),
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
  content_hash: string;
};

type PillarRow = { id: string; title: string; tag: string | null; blurb: string | null; node_hash: string; meta_hash: string | null };
type TopicRow  = { id: string; pillar_id: string; title: string; blurb: string | null; node_hash: string; meta_hash: string | null };

// Read every taxonomy row that carries a committed meta_hash, keyset-paged by id
// so a large taxonomy can't silently truncate at the 1000-row REST cap.
async function readNodes<T extends { id: string }>(supabase: DB, table: "pillars" | "topics", cols: string): Promise<T[]> {
  const PAGE = 1000;
  let last: string | null = null;
  const out: T[] = [];
  while (true) {
    let q = supabase.from(table).select(cols)
      .not("meta_hash", "is", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (last) q = q.gt("id", last);
    const { data, error } = await q;
    if (error) throw error;
    // `.select(string)` with a non-literal column list infers a generic shape,
    // so widen through unknown before narrowing to the row type.
    const rows = (data ?? []) as unknown as T[];
    if (rows.length === 0) break;
    out.push(...rows);
    last = rows[rows.length - 1].id;
    if (rows.length < PAGE) break;
  }
  return out;
}

// Recompute each pillar/topic's node_hash (keccak of its slug) and meta_hash
// (keccak of its canonical metadata) and reconcile against tamper_alerts — the
// taxonomy counterpart of the evidence content_hash audit. A node row whose
// stored hash no longer matches its recomputation has been edited off-chain away
// from what peers committed; open an alert. Resolve alerts that match again.
async function auditNodes(supabase: DB): Promise<{ scanned: number; opened: number; cleared: number }> {
  const pillars = await readNodes<PillarRow>(supabase, "pillars", "id, title, tag, blurb, node_hash, meta_hash");
  const topics  = await readNodes<TopicRow>(supabase, "topics",  "id, pillar_id, title, blurb, node_hash, meta_hash");

  type Drift = { subject_kind: string; node_id: string; hash_kind: string; expected: string; stored: string };
  const drifted: Drift[] = [];
  const clean:   { subject_kind: string; node_id: string; hash_kind: string }[] = [];

  const compare = (subject_kind: string, node_id: string, hash_kind: string, expected: string, storedRaw: string | null) => {
    const exp    = expected.toLowerCase();
    const stored = (storedRaw ?? "").toLowerCase();
    if (exp !== stored) drifted.push({ subject_kind, node_id, hash_kind, expected: exp, stored });
    else                clean.push({ subject_kind, node_id, hash_kind });
  };

  for (const p of pillars) {
    compare("pillar", p.id, "node", slugToBytes32(p.id), p.node_hash);
    compare("pillar", p.id, "meta",
      computeMetaHash({ kind: "pillar", slug: p.id, parent: "", title: p.title, blurb: p.blurb, tag: p.tag }),
      p.meta_hash);
  }
  for (const t of topics) {
    compare("topic", t.id, "node", slugToBytes32(t.id), t.node_hash);
    compare("topic", t.id, "meta",
      computeMetaHash({ kind: "topic", slug: t.id, parent: t.pillar_id, title: t.title, blurb: t.blurb, tag: "" }),
      t.meta_hash);
  }

  const key = (s: string, n: string, h: string) => `${s}|${n}|${h}`;

  // One batched lookup of currently-open node alerts across everything audited.
  const nodeIds = [...new Set([...drifted, ...clean].map(d => d.node_id))];
  const openKeys = new Set<string>();
  for (let i = 0; i < nodeIds.length; i += 1000) {
    const slice = nodeIds.slice(i, i + 1000);
    const { data: openRows } = await supabase
      .from("tamper_alerts")
      .select("subject_kind, node_id, hash_kind")
      .in("subject_kind", ["pillar", "topic"])
      .in("node_id", slice)
      .is("resolved_at", null);
    for (const r of (openRows ?? []) as { subject_kind: string; node_id: string; hash_kind: string }[]) {
      openKeys.add(key(r.subject_kind, r.node_id, r.hash_kind));
    }
  }

  // Open alerts only for drift not already flagged.
  const newAlerts = drifted
    .filter(d => !openKeys.has(key(d.subject_kind, d.node_id, d.hash_kind)))
    .map(d => ({
      subject_kind: d.subject_kind, node_id: d.node_id, hash_kind: d.hash_kind,
      expected_hash: d.expected, stored_hash: d.stored,
    }));
  let opened = 0;
  if (newAlerts.length > 0) {
    await supabase.from("tamper_alerts").insert(newAlerts);
    opened = newAlerts.length;
  }

  // Auto-resolve open alerts whose node now matches again.
  let cleared = 0;
  for (const c of clean) {
    if (!openKeys.has(key(c.subject_kind, c.node_id, c.hash_kind))) continue;
    const { error } = await supabase
      .from("tamper_alerts")
      .update({ resolved_at: new Date().toISOString(), resolution_note: "auto: node hash matched on re-audit" })
      .eq("subject_kind", c.subject_kind).eq("node_id", c.node_id).eq("hash_kind", c.hash_kind)
      .is("resolved_at", null);
    if (!error) cleared++;
  }

  return { scanned: pillars.length + topics.length, opened, cleared };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const supabase = serviceClient();

  await supabase.from("edge_function_heartbeat").upsert(
    { function_name: "audit-content-hash", last_attempt: new Date().toISOString(), last_status: "running" },
    { onConflict: "function_name" },
  );

  // Audit taxonomy nodes first — the taxonomy is small and bounded, so a
  // tampered pillar/topic is always checked even if the evidence scan below
  // later hits its time budget. A node-audit failure must not abort the
  // evidence audit (the alerts it writes persist independently).
  let nodeAudit: { scanned: number; opened: number; cleared: number } | null = null;
  let nodeAuditError: string | null = null;
  try {
    nodeAudit = await auditNodes(supabase);
  } catch (e) {
    nodeAuditError = e instanceof Error ? e.message : String(e);
  }

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
      .select("id, title, source, year, excerpt, link, tier, content_hash")
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
    nodes_scanned:       nodeAudit?.scanned  ?? 0,
    node_alerts_opened:  nodeAudit?.opened   ?? 0,
    node_alerts_cleared: nodeAudit?.cleared  ?? 0,
    nodes_error:         nodeAuditError,
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
