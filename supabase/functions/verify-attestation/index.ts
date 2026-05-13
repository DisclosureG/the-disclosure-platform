import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

// ── Configuration ─────────────────────────────────────────────────────────────

// CHAIN_ID must match the frontend's VITE_CONSENSUS_CHAIN_ID exactly — EIP-712
// signatures are bound to the chainId and a mismatch silently fails the
// verifyTypedData step.  Default to BSC testnet (97); override in env when
// pointing the edge function at mainnet (56) or another chain.
const CHAIN_ID      = Number(Deno.env.get("CONSENSUS_CHAIN_ID") ?? 97);
const CONTRACT_ADDR = Deno.env.get("CONSENSUS_ADDR") ?? null;
const RPC_URL       = Deno.env.get("CONSENSUS_RPC_URL") ?? "https://data-seed-prebsc-1-s1.binance.org:8545/";

const CHALLENGE_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;

// Rate limit: per peer_addr, sliding 60s window
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX      = 30;

// Allowed origins for CORS — keeps sig + tx-receipt as the real auth but
// closes off arbitrary cross-origin attempts.  Override via env.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",")
  .map(s => s.trim());

// ── EIP-712 ───────────────────────────────────────────────────────────────────

function buildDomain(): Record<string, unknown> {
  const d: Record<string, unknown> = {
    name:    "EvidenceConsensus",
    version: "1",
    chainId: CHAIN_ID,
  };
  if (CONTRACT_ADDR) d.verifyingContract = CONTRACT_ADDR;
  return d;
}

const TYPES = {
  Attestation: [
    { name: "evidenceId", type: "string"  },
    { name: "peerAddr",   type: "address" },
    { name: "phase",      type: "string"  },
    { name: "verdict",    type: "string"  },
    { name: "note",       type: "string"  },
  ],
};

// ── Contract ABI + Interface ──────────────────────────────────────────────────
//
// The new EvidenceSubmitted event carries a 4th non-indexed bytes32 — the
// content hash.  Indexer + edge function both need the updated signature.

const CONTRACT_ABI = [
  "function isActivePeer(address) view returns (bool)",
  "function activePeerCount() view returns (uint256)",
  "event EvidenceSubmitted(bytes32 indexed id, uint8 tier, address indexed submitter, bytes32 contentHash)",
  "event ReviewVoteCast(bytes32 indexed id, address indexed voter, bool approve, uint32 approveCount, uint32 rejectCount)",
  "event ChallengeOpened(bytes32 indexed id, address indexed challenger, uint48 challengedAt)",
  "event ChallengeVoteCast(bytes32 indexed id, address indexed voter, bool supportChallenge, uint32 challengeVotes, uint32 defenseVotes)",
  "event EvidenceLapsed(bytes32 indexed id)",
  "event EvidenceDeprecated(bytes32 indexed id, uint32 challengeVotes)",
  "event EvidenceReaffirmed(bytes32 indexed id, uint32 defenseVotes)",
];

// EIP-1271 — smart-contract wallet (Safe, Argent, etc.) signature scheme.
// The signing contract returns the magic value 0x1626ba7e for a valid sig.
const EIP1271_MAGIC = "0x1626ba7e";
const EIP1271_ABI   = [
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
];
const EIP1271_IFACE = new ethers.Interface(EIP1271_ABI);

const IFACE = new ethers.Interface(CONTRACT_ABI);

let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}

// Cache the RPC chain-id check across requests. If CONSENSUS_RPC_URL is
// misconfigured (e.g., pointing at the wrong network because the operator
// forgot to flip it during a mainnet cutover) every tx-receipt check would
// still succeed against the wrong chain. Fail loudly the first time we ask.
let _chainCheck: Promise<void> | null = null;
function ensureRpcChain(): Promise<void> {
  if (_chainCheck) return _chainCheck;
  _chainCheck = (async () => {
    const net = await getProvider().getNetwork();
    if (Number(net.chainId) !== CHAIN_ID) {
      _chainCheck = null; // allow retry on transient mismatch (e.g. provider reconfigured)
      throw new Error(
        `RPC chain ${Number(net.chainId)} does not match CONSENSUS_CHAIN_ID ${CHAIN_ID}`,
      );
    }
  })();
  return _chainCheck;
}

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function checkPeerActive(addr: string): Promise<boolean> {
  if (!CONTRACT_ADDR) return true;
  const c = new ethers.Contract(CONTRACT_ADDR, CONTRACT_ABI, getProvider());
  return await c.isActivePeer(addr);
}

async function fetchActivePeerCount(): Promise<number> {
  if (!CONTRACT_ADDR) return 1;
  const c = new ethers.Contract(CONTRACT_ADDR, CONTRACT_ABI, getProvider());
  return Number(await c.activePeerCount());
}

function uuidToBytes32(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  return "0x" + hex.padStart(64, "0");
}

// Canonical content hash — must match the frontend hashing rule exactly.
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
  return ethers.keccak256(ethers.toUtf8Bytes(canon));
}

async function verifyTxEvent(
  txHash:        string,
  evidenceUuid:  string | null,
  peerAddr:      string | null,
  expectedNames: string[],
  // Optional 3rd-arg bool to assert (e.g. approve / supportChallenge).  When
  // set, the matched event must carry this bool as its 3rd argument — closes
  // the "vote one way on-chain, record opposite verdict off-chain" hole.
  expectedBool?: boolean,
): Promise<ethers.LogDescription> {
  if (!CONTRACT_ADDR) {
    throw new Error("CONSENSUS_ADDR not set; cannot verify tx_hash");
  }
  const provider = getProvider();
  const receipt  = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Transaction not found");
  if (Number(receipt.status) !== 1) throw new Error("Transaction reverted");
  if (receipt.to?.toLowerCase() !== CONTRACT_ADDR.toLowerCase()) {
    throw new Error("Transaction not addressed to consensus contract");
  }
  const wantId   = evidenceUuid ? uuidToBytes32(evidenceUuid).toLowerCase() : null;
  const wantPeer = peerAddr ? peerAddr.toLowerCase() : null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CONTRACT_ADDR.toLowerCase()) continue;
    let parsed: ethers.LogDescription | null = null;
    try { parsed = IFACE.parseLog({ topics: [...log.topics], data: log.data }); }
    catch { continue; }
    if (!parsed || !expectedNames.includes(parsed.name)) continue;

    if (wantId) {
      const idArg = parsed.args[0];
      if (typeof idArg !== "string" || idArg.toLowerCase() !== wantId) continue;
    }
    if (wantPeer) {
      const addrArg = parsed.args[1];
      if (typeof addrArg !== "string" || addrArg.toLowerCase() !== wantPeer) continue;
    }
    if (expectedBool !== undefined) {
      const boolArg = parsed.args[2];
      if (typeof boolArg !== "boolean" || boolArg !== expectedBool) {
        throw new Error(
          `Event ${parsed.name} bool arg mismatch: tx says ${boolArg}, attestation says ${expectedBool}`,
        );
      }
    }
    return parsed;
  }
  throw new Error(
    `Receipt for ${txHash.slice(0, 10)}… does not contain a matching ${expectedNames.join("|")} event`,
  );
}

// ── Threshold helpers (mirror EvidenceConsensus.sol exactly) ─────────────────

function canonizeThreshold(tier: number, n: number): number {
  const pct = tier === 1 ? 45 : tier === 2 ? 35 : 30;
  return Math.max(1, Math.ceil(n * pct / 100));
}
function expelThreshold(n: number): number {
  return Math.max(1, Math.ceil(n * 25 / 100));
}
function deprecateThreshold(tier: number, n: number): number {
  const pct = tier === 1 ? 65 : tier === 2 ? 60 : 55;
  return Math.max(1, Math.ceil(n * pct / 100));
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

// Single round trip to the SECURITY DEFINER `check_and_bump_rate_limit` RPC
// which takes FOR UPDATE on the row and decides window-roll vs. increment vs.
// reject under the same lock.  Closes the boundary TOCTOU where two
// concurrent requests both observed elapsedS > window and both reset count
// to 1, sustaining 2 × RATE_LIMIT_MAX across the rollover.
async function rateLimitOK(
  supabase: ReturnType<typeof createClient>,
  key:      string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("check_and_bump_rate_limit", {
    p_key:      key,
    p_window_s: RATE_LIMIT_WINDOW_S,
    p_max:      RATE_LIMIT_MAX,
  });
  if (error) {
    // Storage failure should not block writes — fail open, matches prior behaviour.
    return true;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return !!(row?.allowed);
}

// ── CORS ──────────────────────────────────────────────────────────────────────

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

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405, origin);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400, origin); }

  const {
    evidence_id,
    peer_addr,
    peer_handle      = null,
    phase            = null,
    verdict          = null,
    note             = null,
    eip712_sig       = null,
    tx_hash          = null,
    action           = null,
    challenge_reason = null,
    tier             = null,
  } = body as {
    evidence_id:       string;
    peer_addr:         string;
    peer_handle?:      string | null;
    phase?:            string | null;
    verdict?:          string | null;
    note?:             string | null;
    eip712_sig?:       string | null;
    tx_hash?:          string | null;
    action?:           string | null;
    challenge_reason?: string | null;
    tier?:             number | null;
  };

  if (!evidence_id || !peer_addr) {
    return json({ error: "Missing required fields: evidence_id, peer_addr" }, 400, origin);
  }
  const peerNorm = (peer_addr as string).toLowerCase();

  const isFinalizeAction = action === "finalize_challenge";
  const isRegisterAction = action === "register_evidence_onchain";

  if (!isFinalizeAction && !isRegisterAction) {
    if (!phase || !verdict) {
      return json({ error: "Missing required fields: phase, verdict" }, 400, origin);
    }
    if (!["review", "challenge"].includes(phase)) {
      return json({ error: `Invalid phase: ${phase}` }, 400, origin);
    }
    if (!["approve", "reject", "challenge", "defend"].includes(verdict)) {
      return json({ error: `Invalid verdict: ${verdict}` }, 400, origin);
    }
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // ── Rate limit ──────────────────────────────────────────────────────────────
  try {
    const ok = await rateLimitOK(supabase, peerNorm);
    if (!ok) return json({ error: "Rate limit exceeded" }, 429, origin);
  } catch (_) { /* don't block on rate-limit storage failure */ }

  // ── RPC chain-id sanity check ──────────────────────────────────────────────
  // Run once, before any tx-receipt check. Cached after first success.
  if (CONTRACT_ADDR) {
    try { await ensureRpcChain(); }
    catch (err: unknown) {
      return json({ error: `RPC chain mismatch: ${err instanceof Error ? err.message : String(err)}` }, 503, origin);
    }
  }

  // ── Peer status check ──────────────────────────────────────────────────────
  let isPeer: boolean;
  try { isPeer = await checkPeerActive(peerNorm); }
  catch (err: unknown) {
    return json({ error: `Peer status check failed: ${err instanceof Error ? err.message : String(err)}` }, 503, origin);
  }
  if (!isPeer) return json({ error: "peer_addr is not an active peer" }, 403, origin);

  // ── Signature verification ─────────────────────────────────────────────────
  if (!isFinalizeAction && !isRegisterAction) {
    if (!eip712_sig) return json({ error: "Missing required field: eip712_sig" }, 400, origin);
    const message = {
      evidenceId: evidence_id,
      peerAddr:   peerNorm,
      phase,
      verdict,
      note: (note as string) ?? "",
    };

    // EOA path first — cheap and accounts for ~all peers today.
    let eoaOk = false;
    try {
      const recovered = ethers.verifyTypedData(buildDomain(), TYPES, message, eip712_sig as string);
      eoaOk = recovered.toLowerCase() === peerNorm;
    } catch { eoaOk = false; }

    if (!eoaOk) {
      // EIP-1271 fallback — for smart-contract wallets (Safe, Argent, etc.)
      // the on-chain contract at `peerNorm` decides whether the signature
      // is valid. We hash the typed data exactly the way EOA recovery
      // would, then ask the wallet contract: `isValidSignature(hash, sig)`.
      // If it returns the EIP-1271 magic 0x1626ba7e, we treat the sig as
      // authentic. RPC failures fall through to a 401 — never accept a
      // sig we couldn't validate.
      let smartOk = false;
      try {
        const digest = ethers.TypedDataEncoder.hash(buildDomain(), TYPES, message);
        const provider = getProvider();
        // First check whether peerNorm has contract code; an EOA returns "0x".
        const code = await provider.getCode(peerNorm);
        if (code && code !== "0x") {
          const data = EIP1271_IFACE.encodeFunctionData(
            "isValidSignature",
            [digest, eip712_sig as string],
          );
          const ret = await provider.call({ to: peerNorm, data });
          if (typeof ret === "string" && ret.startsWith(EIP1271_MAGIC)) {
            smartOk = true;
          }
        }
      } catch { smartOk = false; }

      if (!smartOk) {
        return json({ error: "Signature signer does not match peer_addr" }, 401, origin);
      }
    }
  }

  // ── tx_hash verification ───────────────────────────────────────────────────
  let registerEventContentHash: string | null = null;
  if (CONTRACT_ADDR && tx_hash) {
    try {
      const expectedNames: Record<string, string[]> = {
        review_vote:               ["ReviewVoteCast"],
        open_challenge:            ["ChallengeOpened"],
        challenge_vote:            ["ChallengeVoteCast"],
        finalize_challenge:        ["EvidenceDeprecated", "EvidenceReaffirmed", "EvidenceLapsed"],
        register_evidence_onchain: ["EvidenceSubmitted"],
        mark_lapsed:               ["EvidenceLapsed"],
      };
      const names = expectedNames[String(action)] ?? [];
      if (names.length > 0) {
        const includePeer = !["finalize_challenge", "mark_lapsed"].includes(String(action));
        // For review_vote and challenge_vote we also pin the 3rd event
        // argument (approve / supportChallenge) so the off-chain attestation
        // cannot disagree with the on-chain tx.
        let expectedBool: boolean | undefined;
        if (action === "review_vote") {
          expectedBool = verdict === "approve";
        } else if (action === "challenge_vote") {
          expectedBool = verdict === "challenge";
        }
        const parsed = await verifyTxEvent(
          tx_hash as string,
          evidence_id,
          includePeer ? peerNorm : null,
          names,
          expectedBool,
        );
        // Capture contentHash from EvidenceSubmitted so we can compare against
        // the canonical hash of the off-chain row before flipping the gate.
        if (parsed.name === "EvidenceSubmitted") {
          registerEventContentHash = String(parsed.args[3]).toLowerCase();
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: `tx_hash verification failed: ${msg}` }, 401, origin);
    }
  } else if (CONTRACT_ADDR && !isFinalizeAction && !isRegisterAction) {
    return json({ error: "Missing required field: tx_hash" }, 400, origin);
  } else if (CONTRACT_ADDR && isRegisterAction && !tx_hash) {
    return json({ error: "register_evidence_onchain requires tx_hash" }, 400, origin);
  } else if (CONTRACT_ADDR && isFinalizeAction && !tx_hash) {
    // Defence in depth: never resolve a challenge off-chain unless the chain
    // has already emitted the matching terminal event. Without this check the
    // off-chain row could be flipped to reaffirmed/deprecated while the chain
    // stayed Contested forever — the indexer's status-reconciliation guards
    // (.in("status", ["contested"])) would then never fire and the cache
    // would lie permanently. Frontend always supplies tx_hash; rejecting the
    // tx_hash-less variant closes the manually-crafted-request loophole.
    return json({ error: "finalize_challenge requires tx_hash" }, 400, origin);
  }

  // ── Submission gate ────────────────────────────────────────────────────────
  let evRow: { submitted_onchain: boolean; tier: number; pillar_id: string; title: string;
               source: string | null; year: string | null; excerpt: string | null; link: string | null;
               content_hash: string | null; status: string } | null = null;
  if (!isFinalizeAction) {
    const { data } = await supabase
      .from("evidence")
      .select("submitted_onchain, tier, pillar_id, title, source, year, excerpt, link, content_hash, status")
      .eq("id", evidence_id)
      .maybeSingle();
    evRow = (data as typeof evRow) ?? null;
    if (!evRow) return json({ error: "Unknown evidence" }, 404, origin);
    if (!isRegisterAction && CONTRACT_ADDR && !evRow.submitted_onchain) {
      return json({ error: "Evidence not yet registered on-chain" }, 409, origin);
    }
  }

  // ── Active peer count ──────────────────────────────────────────────────────
  let peerCount: number;
  try { peerCount = await fetchActivePeerCount(); }
  catch (err: unknown) {
    return json({ error: `Peer count unavailable: ${err instanceof Error ? err.message : String(err)}` }, 503, origin);
  }

  // ── Register-evidence-onchain ──────────────────────────────────────────────
  if (isRegisterAction) {
    if (!evRow) return json({ error: "Unknown evidence" }, 404, origin);

    // Cross-check: the contentHash in the EvidenceSubmitted event must match
    // the canonical hash of the off-chain row.  This is the binding that
    // prevents a service-role compromise from silently rewriting content.
    const canonical = computeContentHash(evRow);
    if (CONTRACT_ADDR && registerEventContentHash &&
        canonical.toLowerCase() !== registerEventContentHash) {
      return json({
        error: "Content hash mismatch between on-chain event and stored row",
        expected: canonical, found: registerEventContentHash,
      }, 409, origin);
    }

    await supabase.from("evidence").update({
      submitted_onchain:    true,
      submitted_onchain_at: new Date().toISOString(),
      submission_tx_hash:   tx_hash,
      content_hash:         canonical,
    }).eq("id", evidence_id);
    return json({ ok: true, submitted_onchain: true, content_hash: canonical }, 200, origin);
  }

  // ── Write attestation ──────────────────────────────────────────────────────
  if (!isFinalizeAction) {
    const { error: attErr } = await supabase.from("attestations").upsert(
      {
        evidence_id,
        peer_addr:   peerNorm,
        peer_handle: peer_handle ?? null,
        phase,
        verdict,
        note:        note ?? null,
        eip712_sig:  eip712_sig ?? null,
        tx_hash:     tx_hash ?? null,
      },
      { onConflict: "evidence_id,peer_addr,phase" },
    );
    if (attErr) return json({ error: attErr.message }, 500, origin);
  }

  // ── Status update (atomic, via SECURITY DEFINER RPCs) ─────────────────────
  const extra: Record<string, unknown> = {};

  if (action === "review_vote") {
    const evTier = evRow?.tier ?? (tier as number | null) ?? 2;
    // Counts are recomputed inside the RPC, *after* it acquires FOR UPDATE on
    // the evidence row.  No race window between read and write.
    const { data: applied, error: applyErr } = await supabase.rpc("apply_review_counts", {
      p_evidence_id:  evidence_id,
      p_canon_thresh: canonizeThreshold(evTier, peerCount),
      p_expel_thresh: expelThreshold(peerCount),
    });
    if (applyErr) return json({ error: applyErr.message }, 500, origin);
    const row = Array.isArray(applied) ? applied[0] : applied;
    Object.assign(extra, {
      approve_count: row?.approve_count ?? 0,
      reject_count:  row?.reject_count  ?? 0,
      status:        row?.status ?? null,
    });

  } else if (action === "open_challenge") {
    const curStatus = evRow?.status;
    const evTier    = evRow?.tier ?? 2;

    // Symmetric with the indexer's ChallengeOpened cycle reset: regardless
    // of whether the indexer already flipped status='contested' (chain
    // raced ahead of this fast-path call) or the row is still
    // canon/approved/reaffirmed (we got here first), reset the cycle
    // counters to (1, 0) so the opener's vote is the only count and the
    // trigger's increment on the just-upserted attestation does not stack
    // on top of cycle-1's totals.  Without this carve-out the
    // attestation-side trigger would push cv to 2 (opener + cycle-1
    // remainder) before any other peer voted.
    if (curStatus === "canon" || curStatus === "approved" || curStatus === "reaffirmed") {
      await supabase.from("evidence").update({
        status:              "contested",
        challenged_at:       new Date().toISOString(),
        challenge_reason:    challenge_reason ?? null,
        challenge_votes:     1,
        defense_votes:       0,
        challenge_threshold: deprecateThreshold(evTier, peerCount),
      }).eq("id", evidence_id);
      Object.assign(extra, { status: "contested" });
    } else if (curStatus === "contested") {
      // Indexer beat us to the status flip; we still need to reset cycle
      // counts and (optionally) record the challenge_reason that only the
      // edge fn knows about.  Do not overwrite challenged_at — the
      // indexer's value comes from the chain event's block timestamp and
      // is the authoritative cycle start.
      await supabase.from("evidence").update({
        challenge_reason:    challenge_reason ?? null,
        challenge_votes:     1,
        defense_votes:       0,
        challenge_threshold: deprecateThreshold(evTier, peerCount),
      }).eq("id", evidence_id);
      Object.assign(extra, { status: "contested" });
    } else {
      Object.assign(extra, { status: curStatus });
    }

  } else if (action === "challenge_vote") {
    const evTier = evRow?.tier ?? 2;
    const { data: applied, error: applyErr } = await supabase.rpc("apply_challenge_counts", {
      p_evidence_id:   evidence_id,
      p_deprec_thresh: deprecateThreshold(evTier, peerCount),
    });
    if (applyErr) return json({ error: applyErr.message }, 500, origin);
    const row = Array.isArray(applied) ? applied[0] : applied;
    Object.assign(extra, {
      challenge_votes: row?.challenge_votes ?? 0,
      defense_votes:   row?.defense_votes   ?? 0,
      status:          row?.status ?? null,
    });

  } else if (isFinalizeAction) {
    const { data: ev } = await supabase
      .from("evidence")
      .select("tier, status, challenged_at, challenge_reason")
      .eq("id", evidence_id).single();

    type EvRow = { tier?: number; status?: string; challenged_at?: string; challenge_reason?: string };
    const evData = (ev as EvRow | null) ?? {};

    if (evData.status !== "contested") return json({ error: "Evidence is not contested" }, 400, origin);
    const elapsed = evData.challenged_at
      ? Date.now() - new Date(evData.challenged_at).getTime()
      : Infinity;
    if (elapsed < CHALLENGE_WINDOW_MS) return json({ error: "Challenge window is still open" }, 400, origin);

    const { data: atts } = await supabase
      .from("attestations").select("verdict")
      .eq("evidence_id", evidence_id).eq("phase", "challenge");

    const challengeVotes = (atts ?? []).filter((a: { verdict: string }) => a.verdict === "challenge").length;
    const defenseVotes   = (atts ?? []).filter((a: { verdict: string }) => a.verdict === "defend").length;
    const evTier         = evData.tier ?? 2;

    if (challengeVotes >= deprecateThreshold(evTier, peerCount)) {
      await supabase.from("evidence").update({
        status:            "deprecated",
        deprecated_at:     new Date().toISOString(),
        deprecated_reason: evData.challenge_reason ?? null,
      }).eq("id", evidence_id);
      Object.assign(extra, { status: "deprecated" });
    } else {
      // Matches updated Solidity: window-expiry without deprecation quorum →
      // reaffirmed (silence is not deprecation).
      await supabase.from("evidence").update({ status: "reaffirmed" }).eq("id", evidence_id);
      Object.assign(extra, { status: "reaffirmed", challenge_votes: challengeVotes, defense_votes: defenseVotes });
    }
  }

  return json({ ok: true, verified: !!eip712_sig, ...extra }, 200, origin);
});
