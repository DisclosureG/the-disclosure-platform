import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

// ── nominee-vote ──────────────────────────────────────────────────────────────
//
// Records the OFF-CHAIN deliberation note attached to a peer's nominee
// ENDORSEMENT. The endorsement itself is an on-chain, EIP-712-signed vote
// (PeerGovernance.endorseNominee recovers the voter from a `PeerVote` bound to a
// noteHash); the note TEXT can't live on-chain, so it is recorded here — public,
// attributable, and read by the peer-registry vote history — alongside the SAME
// signature the chain verified.
//
// Gate: the voter must be an active peer, the nominee must be nominated, and the
// endorsement must already be recorded on-chain (gov.hasEndorsed). The submitted
// note is re-hashed and the `PeerVote` signature re-verified, so a stored note
// can't diverge from the one the voter actually signed.

const CHAIN_ID        = Number(Deno.env.get("CONSENSUS_CHAIN_ID") ?? 97);
const CONTRACT_ADDR   = Deno.env.get("CONSENSUS_ADDR") ?? null;
const GOVERNANCE_ADDR = Deno.env.get("GOVERNANCE_ADDR") ?? null;
const RPC_URL         = Deno.env.get("CONSENSUS_RPC_URL") ?? "https://data-seed-prebsc-1-s1.binance.org:8545/";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map(s => s.trim());

const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX      = 30;

const KIND_NOMINEE  = 0; // endorse a nominee
const KIND_NOMINATE = 2; // open a nomination (the nominator's own signed act)

// Mirrors the on-chain PeerVote type recovered by PeerGovernance.
const PEER_VOTE_TYPES = {
  PeerVote: [
    { name: "subject",  type: "address" },
    { name: "kind",     type: "uint8"   },
    { name: "support",  type: "bool"    },
    { name: "round",    type: "uint32"  },
    { name: "noteHash", type: "bytes32" },
  ],
};

const CORE_ABI = ["function isActivePeer(address) view returns (bool)"];
const GOVERNANCE_ABI = [
  "function isNominated(address) view returns (bool)",
  "function nomineeRound(address) view returns (uint32)",
  "function hasEndorsed(address,address) view returns (bool)",
  "function nomineeBy(address) view returns (address)",
];

let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}

// Domain MUST match PeerGovernance's constructor (name "PeerGovernance",
// version "1", verifyingContract = the governance sidecar address).
function peerVoteDomain(): Record<string, unknown> {
  const d: Record<string, unknown> = { name: "PeerGovernance", version: "1", chainId: CHAIN_ID };
  if (GOVERNANCE_ADDR) d.verifyingContract = GOVERNANCE_ADDR;
  return d;
}

// noteHashOf — keccak256(utf8(note)), or the zero hash for an empty note. Must
// stay byte-identical with wallet-impl.noteHashOf and the contract's expectation.
function noteHashOf(note: string): string {
  return note && note.length ? ethers.keccak256(ethers.toUtf8Bytes(note)) : ethers.ZeroHash;
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
    p_key: `nominee:${key}`, p_window_s: RATE_LIMIT_WINDOW_S, p_max: RATE_LIMIT_MAX,
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
    nominee_addr, peer_addr, round = null, note = null, eip712_sig = null, verdict = "endorse",
  } = body as {
    nominee_addr: string; peer_addr: string; round?: number | null;
    note?: string | null; eip712_sig?: string | null; verdict?: string;
  };

  if (!nominee_addr || !peer_addr) return json({ error: "Missing required fields: nominee_addr, peer_addr" }, 400, origin);
  if (!eip712_sig) return json({ error: "Missing required field: eip712_sig" }, 400, origin);
  if (verdict !== "endorse" && verdict !== "nominate") {
    return json({ error: `Invalid verdict: ${verdict}` }, 400, origin);
  }
  const isNominate = verdict === "nominate";

  const voter   = String(peer_addr).toLowerCase();
  const nominee = String(nominee_addr).toLowerCase();
  if (voter === nominee) return json({ error: "cannot vote on your own nomination" }, 400, origin);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const ok = await rateLimitOK(supabase, voter);
    if (!ok) return json({ error: "Rate limit exceeded" }, 429, origin);
  } catch (_) { /* fail open */ }

  // ── On-chain gate: voter is an active peer, nominee is nominated, and the
  //    endorsement is already recorded on-chain; bind the note to the current
  //    nomination round. ──────────────────────────────────────────────────────
  let onchainRound: number;
  if (CONTRACT_ADDR && GOVERNANCE_ADDR) {
    const core = new ethers.Contract(CONTRACT_ADDR, CORE_ABI, getProvider());
    const gov  = new ethers.Contract(GOVERNANCE_ADDR, GOVERNANCE_ABI, getProvider());
    let voterActive = false, nominated = false;
    // For an ENDORSE the gate is gov.hasEndorsed(nominee, voter); for a NOMINATE
    // it's that the voter IS the on-chain nominator (gov.nomineeBy == voter).
    let acted = false;
    try {
      const reads = [core.isActivePeer(voter), gov.isNominated(nominee)];
      reads.push(isNominate ? gov.nomineeBy(nominee) : gov.hasEndorsed(nominee, voter));
      const [va, nom, third] = await Promise.all(reads);
      voterActive = va; nominated = nom;
      acted = isNominate ? String(third).toLowerCase() === voter : !!third;
    } catch (err: unknown) {
      return json({ error: `Chain read failed: ${err instanceof Error ? err.message : String(err)}` }, 503, origin);
    }
    if (!voterActive) return json({ error: "peer_addr is not an active peer" }, 403, origin);
    if (!nominated)   return json({ error: "nominee is not nominated" }, 409, origin);
    if (!acted)       return json({ error: isNominate ? "nomination not found on-chain" : "endorsement not found on-chain" }, 409, origin);
    onchainRound = Number(await gov.nomineeRound(nominee));
    if (round != null && Number(round) !== onchainRound) {
      return json({ error: `stale round: signed ${round}, current ${onchainRound}` }, 409, origin);
    }
  } else {
    onchainRound = Number(round) || 1;
  }

  // ── Re-verify the PeerVote signature (binds voter + note + round). ──────────
  const message = {
    subject:  nominee,
    kind:     isNominate ? KIND_NOMINATE : KIND_NOMINEE,
    support:  true,
    round:    onchainRound,
    noteHash: noteHashOf((note as string) ?? ""),
  };
  let recovered = "";
  try { recovered = ethers.verifyTypedData(peerVoteDomain(), PEER_VOTE_TYPES, message, eip712_sig as string); }
  catch { recovered = ""; }
  if (recovered.toLowerCase() !== voter) {
    return json({ error: "Signature signer does not match peer_addr" }, 401, origin);
  }

  const { error: wErr } = await supabase.from("nominee_votes").upsert(
    {
      nominee_addr: nominee, voter_addr: voter, round: onchainRound,
      verdict, note: (note as string) ?? null, eip712_sig,
    },
    { onConflict: "nominee_addr,voter_addr,round,verdict" },
  );
  if (wErr) return json({ error: wErr.message }, 500, origin);

  return json({ ok: true, round: onchainRound, verdict }, 200, origin);
});
