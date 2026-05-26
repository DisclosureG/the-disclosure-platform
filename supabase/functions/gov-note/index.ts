import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

// ── gov-note ────────────────────────────────────────────────────────────────
//
// Records the OFF-CHAIN deliberation note attached to a NODE/OWNER-scoped
// governance vote — taxonomy RETIRE (motion/vote) and FORCE-RENOUNCE
// (motion/vote). Each act is an on-chain, EIP-712 `Vote`-signed call that
// EvidenceConsensus recovers (phase 3 retire, 4 force-renounce; bindingId = the
// node id, or the fixed force-renounce sentinel). The note TEXT can't live
// on-chain, so it is recorded here — public, attributable, and read by the
// shared vote-history feed — alongside the SAME signature the chain verified.
//
// Gate: the voter must be an active peer, the submitted note re-hashes to the
// signed noteHash, the EIP-712 `Vote` signature recovers to the voter, and the
// tx receipt contains the matching on-chain vote event from that voter.

const CHAIN_ID      = Number(Deno.env.get("CONSENSUS_CHAIN_ID") ?? 97);
const CONTRACT_ADDR = Deno.env.get("CONSENSUS_ADDR") ?? null;
const RPC_URL       = Deno.env.get("CONSENSUS_RPC_URL") ?? "https://data-seed-prebsc-1-s1.binance.org:8545/";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map(s => s.trim());

const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX      = 30;

const PHASE_RETIRE = 3;
const PHASE_FORCE  = 4;
const ZERO_BYTES32 = "0x" + "0".repeat(64);

// Mirrors the core `Vote` type recovered by EvidenceConsensus.
const VOTE_TYPES = {
  Vote: [
    { name: "bindingId", type: "bytes32" },
    { name: "phase",     type: "uint8"   },
    { name: "support",   type: "bool"    },
    { name: "round",     type: "uint32"  },
    { name: "noteHash",  type: "bytes32" },
  ],
};

const CORE_ABI = [
  "function isActivePeer(address) view returns (bool)",
  "event NodeRetireVoteCast(bytes32 indexed id, address indexed voter, uint32 votes, uint256 threshold)",
  "event ForceRenounceVoteCast(address indexed voter, uint32 votes, uint256 threshold)",
];
const IFACE = new ethers.Interface(CORE_ABI);

const EIP1271_MAGIC = "0x1626ba7e";
const EIP1271_IFACE = new ethers.Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}

// Domain MUST match EvidenceConsensus's constructor (name "EvidenceConsensus",
// version "1", verifyingContract = the core address).
function buildDomain(): Record<string, unknown> {
  const d: Record<string, unknown> = { name: "EvidenceConsensus", version: "1", chainId: CHAIN_ID };
  if (CONTRACT_ADDR) d.verifyingContract = CONTRACT_ADDR;
  return d;
}

function corsHeaders(origin: string | null): Record<string, string> {
  let allow = "*";
  if (!ALLOWED_ORIGINS.includes("*") && origin) {
    allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "null";
  }
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary":                         "Origin",
  };
}
function json(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function rateLimitOK(supabase: ReturnType<typeof createClient>, key: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("check_and_bump_rate_limit", {
    p_key: `gov:${key}`, p_window_s: RATE_LIMIT_WINDOW_S, p_max: RATE_LIMIT_MAX,
  });
  if (error) return true; // fail open on storage failure
  const row = Array.isArray(data) ? data[0] : data;
  return !!(row?.allowed);
}

// Confirm the tx receipt contains the matching governance vote event from this
// voter (both motion and vote emit the *VoteCast event). Retire is keyed by node
// id; force-renounce has no subject.
async function verifyGovEvent(txHash: string, kind: string, subject: string, voter: string): Promise<void> {
  if (!CONTRACT_ADDR) throw new Error("CONSENSUS_ADDR not set; cannot verify tx_hash");
  const receipt = await getProvider().getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Transaction not found");
  if (Number(receipt.status) !== 1) throw new Error("Transaction reverted");
  if (receipt.to?.toLowerCase() !== CONTRACT_ADDR.toLowerCase()) {
    throw new Error("Transaction not addressed to consensus contract");
  }
  const wantVoter = voter.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CONTRACT_ADDR.toLowerCase()) continue;
    let parsed: ethers.LogDescription | null = null;
    try { parsed = IFACE.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
    if (!parsed) continue;
    if (kind === "retire" && parsed.name === "NodeRetireVoteCast") {
      if (String(parsed.args[0]).toLowerCase() === subject.toLowerCase() &&
          String(parsed.args[1]).toLowerCase() === wantVoter) return;
    }
    if (kind === "force_renounce" && parsed.name === "ForceRenounceVoteCast") {
      if (String(parsed.args[0]).toLowerCase() === wantVoter) return;
    }
  }
  throw new Error("Receipt does not contain a matching governance vote event from this peer");
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405, origin);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400, origin); }

  const {
    kind, subject, topic_id = null, verdict, round = null,
    note = null, note_hash = null, eip712_sig = null, tx_hash = null,
    peer_addr, peer_handle = null,
  } = body as {
    kind: string; subject: string; topic_id?: string | null; verdict: string;
    round?: number | null; note?: string | null; note_hash?: string | null;
    eip712_sig?: string | null; tx_hash?: string | null; peer_addr: string; peer_handle?: string | null;
  };

  if (kind !== "retire" && kind !== "force_renounce") return json({ error: `Invalid kind: ${kind}` }, 400, origin);
  const wantVerdict = kind === "retire" ? "retire" : "renounce";
  if (verdict !== wantVerdict) return json({ error: `${kind} requires verdict '${wantVerdict}'` }, 400, origin);
  if (!subject || !peer_addr)  return json({ error: "Missing required fields: subject, peer_addr" }, 400, origin);
  if (!eip712_sig)             return json({ error: "Missing required field: eip712_sig" }, 400, origin);
  if (round === null || round === undefined) return json({ error: "Missing required field: round" }, 400, origin);

  const voter = String(peer_addr).toLowerCase();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const ok = await rateLimitOK(supabase, voter);
    if (!ok) return json({ error: "Rate limit exceeded" }, 429, origin);
  } catch (_) { /* fail open */ }

  // ── Peer status ─────────────────────────────────────────────────────────────
  if (CONTRACT_ADDR) {
    let active = false;
    try {
      const core = new ethers.Contract(CONTRACT_ADDR, CORE_ABI, getProvider());
      active = await core.isActivePeer(voter);
    } catch (err: unknown) {
      return json({ error: `Peer status check failed: ${err instanceof Error ? err.message : String(err)}` }, 503, origin);
    }
    if (!active) return json({ error: "peer_addr is not an active peer" }, 403, origin);
  }

  // ── Bind the note to the signed digest ──────────────────────────────────────
  const noteStr      = (note as string) ?? "";
  const wantNoteHash = ethers.keccak256(ethers.toUtf8Bytes(noteStr)).toLowerCase();
  const gotNoteHash  = (note_hash ? String(note_hash) : ZERO_BYTES32).toLowerCase();
  const emptyNoteOk  = noteStr.length === 0 && gotNoteHash === ZERO_BYTES32;
  if (gotNoteHash !== wantNoteHash && !emptyNoteOk) {
    return json({ error: "note_hash does not match keccak256(note)" }, 401, origin);
  }

  // ── Re-verify the on-chain Vote signature ───────────────────────────────────
  const message = {
    bindingId: subject,
    phase:     kind === "retire" ? PHASE_RETIRE : PHASE_FORCE,
    support:   true,
    round:     Number(round),
    noteHash:  gotNoteHash,
  };
  let eoaOk = false;
  try {
    const recovered = ethers.verifyTypedData(buildDomain(), VOTE_TYPES, message, eip712_sig as string);
    eoaOk = recovered.toLowerCase() === voter;
  } catch { eoaOk = false; }
  if (!eoaOk) {
    // EIP-1271 fallback for smart-contract wallets.
    let smartOk = false;
    try {
      const digest = ethers.TypedDataEncoder.hash(buildDomain(), VOTE_TYPES, message);
      const code = await getProvider().getCode(voter);
      if (code && code !== "0x") {
        const data = EIP1271_IFACE.encodeFunctionData("isValidSignature", [digest, eip712_sig as string]);
        const ret = await getProvider().call({ to: voter, data });
        if (typeof ret === "string" && ret.startsWith(EIP1271_MAGIC)) smartOk = true;
      }
    } catch { smartOk = false; }
    if (!smartOk) return json({ error: "Signature signer does not match peer_addr" }, 401, origin);
  }

  // ── Confirm the vote landed on-chain ────────────────────────────────────────
  if (CONTRACT_ADDR) {
    if (!tx_hash) return json({ error: "Missing required field: tx_hash" }, 400, origin);
    try { await verifyGovEvent(tx_hash as string, kind, subject, voter); }
    catch (err: unknown) {
      return json({ error: `tx_hash verification failed: ${err instanceof Error ? err.message : String(err)}` }, 401, origin);
    }
  }

  const { error: wErr } = await supabase.from("gov_votes").upsert(
    {
      kind, subject: String(subject).toLowerCase(), topic_id: topic_id ?? null,
      verdict, round: Number(round), peer_addr: voter, peer_handle: peer_handle ?? null,
      note: (note as string) ?? null, note_hash: gotNoteHash, eip712_sig, tx_hash: tx_hash ?? null,
    },
    { onConflict: "kind,subject,peer_addr,round" },
  );
  if (wErr) return json({ error: wErr.message }, 500, origin);

  return json({ ok: true, kind, verdict, round: Number(round) }, 200, origin);
});
