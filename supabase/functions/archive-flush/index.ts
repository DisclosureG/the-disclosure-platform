// Archive flush keeper for EvidenceArchive.
//
// Pushes the human-readable strings that the core only commits as hashes
// (evidence content, taxonomy node metadata, deliberation note text) onto the
// EvidenceArchive sidecar, so the chain is a COMPLETE backup and Supabase is a
// disposable projection. Every write is verified on-chain against the core's
// hash (or, for notes, self-keyed by keccak(text) == the vote's noteHash), so
// this keeper's key grants no authority — anyone could publish the same bytes.
//
// It is the single mechanism that gets content on-chain (live sweep) AND the
// backfill tool for pre-existing rows. Idempotent: it skips anything already
// published (checked via the archive's public getters) and is bounded per run,
// so pg_cron can call it frequently and it converges. Manual invocation is safe.
//
// Reads off-chain content from the DB; after a wipe there is nothing to push
// (everything is already on-chain) and the indexer rebuilds the DB from the
// archive's events. Run frequently to keep the pre-flush loss window small.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

const ARCHIVE_ADDR = Deno.env.get("CONTENT_ARCHIVE_ADDR") ?? null;
const RPC_URL      = Deno.env.get("CONSENSUS_RPC_URL") ?? "https://bsc-rpc.publicnode.com";
const KEEPER_KEY   = Deno.env.get("KEEPER_PRIVATE_KEY") ?? null;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Per-run caps so a single invocation stays well under the edge timeout; cron
// repeats until the backlog drains.
const META_CAP    = 40;
const CONTENT_CAP = 25;
const NOTE_CAP    = 40;

const ARCHIVE_ABI = [
  "function evidenceContent(bytes32) view returns (string)",
  "function nodeMeta(bytes32) view returns (string)",
  "function noteText(bytes32) view returns (string)",
  "function publishEvidenceContent(bytes32 id, string canonical, string extra)",
  "function publishNodeMetas(bytes32[] ids, string[] canonicals)",
  "function publishNotes(string[] texts)",
];

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function uuidToBytes32(uuid: string): string {
  return "0x" + uuid.replace(/-/g, "").padStart(64, "0");
}

// Canonical strings — MUST stay byte-identical to canonicalContentJSON /
// canonicalMetaJSON in src/lib/wallet-impl.js, or keccak won't match the core's
// stored hash and publishEvidenceContent/publishNodeMeta will revert.
function canonicalContentJSON(r: Record<string, unknown>): string {
  return JSON.stringify({
    title:   String(r.title ?? "").trim(),
    source:  String(r.source ?? "").trim(),
    year:    String(r.year ?? "").trim(),
    excerpt: String(r.excerpt ?? "").trim(),
    link:    String(r.link ?? "").trim(),
    tier:    Number(r.tier),
  });
}
function canonicalMetaJSON(m: { kind: string; slug: string; parent: string; title: string; blurb: string; tag: string }): string {
  return JSON.stringify({
    kind:   String(m.kind),
    slug:   String(m.slug ?? "").trim(),
    parent: String(m.parent ?? "").trim(),
    title:  String(m.title ?? "").trim(),
    blurb:  String(m.blurb ?? "").trim(),
    tag:    String(m.tag ?? "").trim(),
  });
}

async function writeHeartbeat(
  supabase: ReturnType<typeof createClient>,
  status: "running" | "ok" | "error",
  payload: Record<string, unknown> = {},
  markSuccess = false,
) {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    function_name: "archive-flush",
    last_attempt:  now,
    last_status:   status,
    last_payload:  payload,
  };
  if (markSuccess) row.last_success = now;
  await supabase.from("edge_function_heartbeat").upsert(row, { onConflict: "function_name" });
}

async function flushNodeMeta(supabase, archive): Promise<number> {
  const [{ data: pillars }, { data: topics }] = await Promise.all([
    supabase.from("pillars").select("id, node_hash, title, tag, blurb"),
    supabase.from("topics").select("id, pillar_id, node_hash, title, blurb"),
  ]);
  const cands: { hash: string; canonical: string }[] = [];
  for (const p of pillars ?? []) {
    if (!p.node_hash) continue;
    cands.push({ hash: p.node_hash, canonical: canonicalMetaJSON({ kind: "pillar", slug: p.id, parent: "", title: p.title, blurb: p.blurb ?? "", tag: p.tag ?? "" }) });
  }
  for (const t of topics ?? []) {
    if (!t.node_hash) continue;
    cands.push({ hash: t.node_hash, canonical: canonicalMetaJSON({ kind: "topic", slug: t.id, parent: t.pillar_id ?? "", title: t.title, blurb: t.blurb ?? "", tag: "" }) });
  }
  const ids: string[] = [], canons: string[] = [];
  for (const c of cands) {
    if (ids.length >= META_CAP) break;
    if ((await archive.nodeMeta(c.hash)) !== "") continue;   // already published
    ids.push(c.hash); canons.push(c.canonical);
  }
  if (!ids.length) return 0;
  const tx = await archive.publishNodeMetas(ids, canons);
  await tx.wait();
  return ids.length;
}

async function flushContent(supabase, archive): Promise<number> {
  // Only rows whose evidence is registered on-chain (contentHash set) can be
  // published; the contract reverts otherwise.
  const { data: rows } = await supabase
    .from("evidence")
    .select("id, title, source, year, excerpt, link, tier, type, tags")
    .eq("submitted_onchain", true)
    .limit(CONTENT_CAP * 4);
  let n = 0;
  for (const r of rows ?? []) {
    if (n >= CONTENT_CAP) break;
    const id = uuidToBytes32(r.id);
    if ((await archive.evidenceContent(id)) !== "") continue;  // already published
    const extra = JSON.stringify({ type: r.type ?? null, tags: r.tags ?? [] });
    try {
      const tx = await archive.publishEvidenceContent(id, canonicalContentJSON(r), extra);
      await tx.wait();
      n++;
    } catch (_e) { /* not yet materialized on-chain / hash drift — skip, audit catches drift */ }
  }
  return n;
}

async function flushNotes(supabase, archive): Promise<number> {
  // Gather note text from every off-chain store; dedupe by keccak(text), which
  // is exactly the on-chain noteHash the signed vote committed.
  const sources = await Promise.all([
    supabase.from("attestations").select("note"),
    supabase.from("nominee_votes").select("note"),
    supabase.from("revocation_votes").select("note"),
    supabase.from("gov_votes").select("note"),
    supabase.from("bindings").select("challenge_reason"),
  ]);
  const byHash = new Map<string, string>();
  const add = (t: unknown) => {
    const s = String(t ?? "");
    if (!s.length) return;
    byHash.set(ethers.keccak256(ethers.toUtf8Bytes(s)), s);
  };
  for (const r of sources[0].data ?? []) add(r.note);
  for (const r of sources[1].data ?? []) add(r.note);
  for (const r of sources[2].data ?? []) add(r.note);
  for (const r of sources[3].data ?? []) add(r.note);
  for (const r of sources[4].data ?? []) add(r.challenge_reason);

  const texts: string[] = [];
  for (const [hash, text] of byHash) {
    if (texts.length >= NOTE_CAP) break;
    if ((await archive.noteText(hash)) !== "") continue;  // already published
    texts.push(text);
  }
  if (!texts.length) return 0;
  const tx = await archive.publishNotes(texts);
  await tx.wait();
  return texts.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  if (!ARCHIVE_ADDR || !KEEPER_KEY) {
    return json({ error: "CONTENT_ARCHIVE_ADDR / KEEPER_PRIVATE_KEY not set" }, 500);
  }
  await writeHeartbeat(supabase, "running");
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(KEEPER_KEY, provider);
    const archive  = new ethers.Contract(ARCHIVE_ADDR, ARCHIVE_ABI, wallet);

    // Independent steps — one failing doesn't block the others.
    const out: Record<string, unknown> = {};
    for (const [name, fn] of [["meta", flushNodeMeta], ["content", flushContent], ["notes", flushNotes]] as const) {
      try { out[name] = await fn(supabase, archive); }
      catch (e) { out[name + "_error"] = String((e as Error).message ?? e); }
    }
    await writeHeartbeat(supabase, "ok", out, true);
    return json({ ok: true, ...out });
  } catch (e) {
    await writeHeartbeat(supabase, "error", { error: String((e as Error).message ?? e) });
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
