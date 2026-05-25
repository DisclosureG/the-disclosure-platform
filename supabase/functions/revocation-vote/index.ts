import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

// ── revocation-vote ───────────────────────────────────────────────────────────
//
// Records a peer's OFF-CHAIN position on an open peer-revocation. The contract
// only tracks DISCARD votes (voteRevoke, ceil(n/2) to remove); there is no
// on-chain "keep". A keep is therefore a first-class EIP-712-signed dissent
// (mirrors the taxonomy reject) written here with the service role — public,
// attributable, and read by the peer-review batch gate so the network must take
// a position on every open revocation and move on.
//
// The signed message reuses the shared "Attestation" EIP-712 type, mapping:
//   evidenceId = String(round)   topicId = subject_addr   peerAddr = voter
//   phase = "revocation"         verdict = "keep" | "discard"   note
// so the signature is bound to the CURRENT on-chain revocation round — a
// re-motion bumps the round and invalidates an older keep.

const CHAIN_ID      = Number(Deno.env.get("CONSENSUS_CHAIN_ID") ?? 97);
const CONTRACT_ADDR = Deno.env.get("CONSENSUS_ADDR") ?? null;
// Revocation state (revocationActive / revokeRound) moved to the PeerGovernance
// sidecar; isActivePeer stays on the core. Read each from the right contract.
const GOVERNANCE_ADDR = Deno.env.get("GOVERNANCE_ADDR") ?? null;
const RPC_URL       = Deno.env.get("CONSENSUS_RPC_URL") ?? "https://data-seed-prebsc-1-s1.binance.org:8545/";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map(s => s.trim());

const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX      = 30;

const TYPES = {
  Attestation: [
    { name: "evidenceId", type: "string"  },
    { name: "topicId",    type: "string"  },
    { name: "peerAddr",   type: "address" },
    { name: "phase",      type: "string"  },
    { name: "verdict",    type: "string"  },
    { name: "note",       type: "string"  },
  ],
};

const CONTRACT_ABI = [
  "function isActivePeer(address) view returns (bool)",
];
const GOVERNANCE_ABI = [
  "function revocationActive(address) view returns (bool)",
  "function revokeRound(address) view returns (uint32)",
];

let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}

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
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function rateLimitOK(supabase: ReturnType<typeof createClient>, key: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("check_and_bump_rate_limit", {
    p_key: `revoke:${key}`, p_window_s: RATE_LIMIT_WINDOW_S, p_max: RATE_LIMIT_MAX,
  });
  if (error) return true; // fail open on storage failure
  const row = Array.isArray(data) ? data[0] : data;
  return !!(row?.allowed);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405, origin);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400, origin); }

  const {
    subject_addr, peer_addr, round = null, verdict = null, note = null, eip712_sig = null,
  } = body as {
    subject_addr: string; peer_addr: string; round?: number | null;
    verdict?: string | null; note?: string | null; eip712_sig?: string | null;
  };

  if (!subject_addr || !peer_addr) return json({ error: "Missing required fields: subject_addr, peer_addr" }, 400, origin);
  if (verdict !== "keep" && verdict !== "discard") return json({ error: "verdict must be 'keep' or 'discard'" }, 400, origin);
  if (!eip712_sig) return json({ error: "Missing required field: eip712_sig" }, 400, origin);

  const voter   = String(peer_addr).toLowerCase();
  const subject = String(subject_addr).toLowerCase();
  if (voter === subject) return json({ error: "cannot vote on your own revocation" }, 400, origin);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const ok = await rateLimitOK(supabase, voter);
    if (!ok) return json({ error: "Rate limit exceeded" }, 429, origin);
  } catch (_) { /* fail open */ }

  // ── On-chain gate: voter must be an active peer; subject must be under an
  //    active revocation; bind the vote to the CURRENT round. ──────────────────
  let onchainRound: number;
  if (CONTRACT_ADDR && GOVERNANCE_ADDR) {
    const core = new ethers.Contract(CONTRACT_ADDR, CONTRACT_ABI, getProvider());
    const gov  = new ethers.Contract(GOVERNANCE_ADDR, GOVERNANCE_ABI, getProvider());
    let voterActive = false, revActive = false;
    try {
      [voterActive, revActive] = await Promise.all([core.isActivePeer(voter), gov.revocationActive(subject)]);
    } catch (err: unknown) {
      return json({ error: `Chain read failed: ${err instanceof Error ? err.message : String(err)}` }, 503, origin);
    }
    if (!voterActive) return json({ error: "peer_addr is not an active peer" }, 403, origin);
    if (!revActive)   return json({ error: "subject has no active revocation" }, 409, origin);
    onchainRound = Number(await gov.revokeRound(subject));
    if (round != null && Number(round) !== onchainRound) {
      return json({ error: `stale round: signed ${round}, current ${onchainRound}` }, 409, origin);
    }
  } else {
    onchainRound = Number(round) || 1;
  }

  // ── Signature verification (EOA). The message is bound to the round. ────────
  const message = {
    evidenceId: String(onchainRound),
    topicId:    subject,
    peerAddr:   voter,
    phase:      "revocation",
    verdict,
    note: (note as string) ?? "",
  };
  let recovered = "";
  try { recovered = ethers.verifyTypedData(buildDomain(), TYPES, message, eip712_sig as string); }
  catch { recovered = ""; }
  if (recovered.toLowerCase() !== voter) {
    return json({ error: "Signature signer does not match peer_addr" }, 401, origin);
  }

  const { error: wErr } = await supabase.from("revocation_votes").upsert(
    {
      subject_addr: subject, voter_addr: voter, round: onchainRound,
      verdict, note: (note as string) ?? null, eip712_sig,
    },
    { onConflict: "subject_addr,voter_addr,round" },
  );
  if (wErr) return json({ error: wErr.message }, 500, origin);

  return json({ ok: true, round: onchainRound, verdict }, 200, origin);
});
