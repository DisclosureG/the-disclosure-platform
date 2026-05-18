// Verify-attestation edge function for BehaviourConsensus.
//
// Parallel to verify-attestation/index.ts. Two notable differences:
//   - EIP-712 domain name is "BehaviourConsensus" (chainId + verifyingContract
//     point at the behaviour contract).
//   - The peer-active check runs against the EvidenceConsensus address
//     (EVIDENCE_CONSENSUS_ADDR) — the peer registry is shared across the two
//     archives and lives in the evidence contract.
//   - Records reference the behaviour table; vote-apply RPCs are the
//     `_behaviour_` variants from 20260518000500.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ethers } from "npm:ethers@6";

// ── Configuration ─────────────────────────────────────────────────────────────

const CHAIN_ID           = Number(Deno.env.get("BEHAVIOUR_CONSENSUS_CHAIN_ID")
                                ?? Deno.env.get("CONSENSUS_CHAIN_ID") ?? 97);
const BEHAVIOUR_ADDR     = Deno.env.get("BEHAVIOUR_CONSENSUS_ADDR") ?? null;
const EVIDENCE_ADDR      = Deno.env.get("EVIDENCE_CONSENSUS_ADDR")
                        ?? Deno.env.get("CONSENSUS_ADDR") ?? null;
const RPC_URL            = Deno.env.get("BEHAVIOUR_CONSENSUS_RPC_URL")
                        ?? Deno.env.get("CONSENSUS_RPC_URL")
                        ?? "https://data-seed-prebsc-1-s1.binance.org:8545/";

const CHALLENGE_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX      = 30;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",")
  .map(s => s.trim());

// ── EIP-712 ───────────────────────────────────────────────────────────────────

function buildDomain(): Record<string, unknown> {
  const d: Record<string, unknown> = {
    name:    "BehaviourConsensus",
    version: "1",
    chainId: CHAIN_ID,
  };
  if (BEHAVIOUR_ADDR) d.verifyingContract = BEHAVIOUR_ADDR;
  return d;
}

const TYPES = {
  Attestation: [
    { name: "behaviourId", type: "string"  },
    { name: "peerAddr",    type: "address" },
    { name: "phase",       type: "string"  },
    { name: "verdict",     type: "string"  },
    { name: "note",        type: "string"  },
  ],
};

// ── ABI: behaviour-contract events + the read-only peer registry on evidence ──

const BEHAVIOUR_ABI = [
  "event BehaviourSubmitted(bytes32 indexed id, uint8 tier, uint8 domain, address indexed submitter, bytes32 modelHash, bytes32 inputHash, bytes32 outputHash)",
  "event ReviewVoteCast(bytes32 indexed id, address indexed voter, bool approve, uint32 approveCount, uint32 rejectCount)",
  "event ChallengeOpened(bytes32 indexed id, address indexed challenger, uint48 challengedAt, string grounds)",
  "event ChallengeVoteCast(bytes32 indexed id, address indexed voter, bool supportChallenge, uint32 challengeVotes, uint32 defenseVotes)",
  "event BehaviourLapsed(bytes32 indexed id)",
  "event BehaviourDeprecated(bytes32 indexed id, uint32 challengeVotes)",
  "event BehaviourReaffirmed(bytes32 indexed id, uint32 defenseVotes)",
];

const EVIDENCE_PEERS_ABI = [
  "function isActivePeer(address) view returns (bool)",
  "function activePeerCount() view returns (uint256)",
];

const EIP1271_MAGIC = "0x1626ba7e";
const EIP1271_ABI   = [
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
];
const EIP1271_IFACE = new ethers.Interface(EIP1271_ABI);

const BH_IFACE = new ethers.Interface(BEHAVIOUR_ABI);

let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}

let _chainCheck: Promise<void> | null = null;
function ensureRpcChain(): Promise<void> {
  if (_chainCheck) return _chainCheck;
  _chainCheck = (async () => {
    const net = await getProvider().getNetwork();
    if (Number(net.chainId) !== CHAIN_ID) {
      _chainCheck = null;
      throw new Error(
        `RPC chain ${Number(net.chainId)} does not match BEHAVIOUR_CONSENSUS_CHAIN_ID ${CHAIN_ID}`,
      );
    }
  })();
  return _chainCheck;
}

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function checkPeerActive(addr: string): Promise<boolean> {
  // Peer registry lives in the evidence contract; the behaviour contract
  // reads it across the boundary. Same applies here.
  if (!EVIDENCE_ADDR) return true;
  const c = new ethers.Contract(EVIDENCE_ADDR, EVIDENCE_PEERS_ABI, getProvider());
  return await c.isActivePeer(addr);
}

async function fetchActivePeerCount(): Promise<number> {
  if (!EVIDENCE_ADDR) return 1;
  const c = new ethers.Contract(EVIDENCE_ADDR, EVIDENCE_PEERS_ABI, getProvider());
  return Number(await c.activePeerCount());
}

function uuidToBytes32(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  return "0x" + hex.padStart(64, "0");
}

// Canonical triple-hash. Order is part of the protocol — must match the
// frontend hashing helper and the contract's `tripleHash` view.
function computeTripleHash(payload: {
  model_hash:  string;
  input_hash:  string;
  output_hash: string;
}): string {
  const m = String(payload.model_hash  ?? "").toLowerCase();
  const i = String(payload.input_hash  ?? "").toLowerCase();
  const o = String(payload.output_hash ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(m) || !/^0x[0-9a-f]{64}$/.test(i) || !/^0x[0-9a-f]{64}$/.test(o)) {
    throw new Error("triple-hash inputs must be 0x-prefixed 32-byte hex");
  }
  return ethers.keccak256(ethers.concat([m, i, o]));
}

// Canonical-JSON keccak helpers. Mirror src/lib/wallet-impl.js exactly.
// Changing the canonicalisation rule changes every hash, so the three
// implementations (frontend, this function, audit-behaviour-hash) move
// together.
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

async function verifyTxEvent(
  txHash:        string,
  behaviourUuid: string | null,
  peerAddr:      string | null,
  expectedNames: string[],
  expectedBool?: boolean,
): Promise<ethers.LogDescription> {
  if (!BEHAVIOUR_ADDR) {
    throw new Error("BEHAVIOUR_CONSENSUS_ADDR not set; cannot verify tx_hash");
  }
  const provider = getProvider();
  const receipt  = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Transaction not found");
  if (Number(receipt.status) !== 1) throw new Error("Transaction reverted");
  if (receipt.to?.toLowerCase() !== BEHAVIOUR_ADDR.toLowerCase()) {
    throw new Error("Transaction not addressed to behaviour contract");
  }
  const wantId   = behaviourUuid ? uuidToBytes32(behaviourUuid).toLowerCase() : null;
  const wantPeer = peerAddr ? peerAddr.toLowerCase() : null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== BEHAVIOUR_ADDR.toLowerCase()) continue;
    let parsed: ethers.LogDescription | null = null;
    try { parsed = BH_IFACE.parseLog({ topics: [...log.topics], data: log.data }); }
    catch { continue; }
    if (!parsed || !expectedNames.includes(parsed.name)) continue;

    if (wantId) {
      const idArg = parsed.args[0];
      if (typeof idArg !== "string" || idArg.toLowerCase() !== wantId) continue;
    }
    if (wantPeer) {
      // BehaviourSubmitted puts `submitter` at args[3] (id, tier, domain, submitter, ...);
      // every other event puts the peer address at args[1].
      const peerIdx = parsed.name === "BehaviourSubmitted" ? 3 : 1;
      const addrArg = parsed.args[peerIdx];
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

// ── Threshold helpers (mirror BehaviourConsensus.sol exactly) ─────────────────

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

async function rateLimitOK(
  supabase: ReturnType<typeof createClient>,
  key:      string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("check_and_bump_rate_limit", {
    p_key:      key,
    p_window_s: RATE_LIMIT_WINDOW_S,
    p_max:      RATE_LIMIT_MAX,
  });
  if (error) return true; // fail-open on storage failure
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
    behaviour_id,
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
    behaviour_id:      string;
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

  if (!behaviour_id || !peer_addr) {
    return json({ error: "Missing required fields: behaviour_id, peer_addr" }, 400, origin);
  }
  const peerNorm = (peer_addr as string).toLowerCase();

  const isFinalizeAction = action === "finalize_challenge";
  const isRegisterAction = action === "register_behaviour_onchain";

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

  // Rate limit: prefix 'bh:' so behaviour and evidence counts stay separate.
  try {
    const ok = await rateLimitOK(supabase, `bh:${peerNorm}`);
    if (!ok) return json({ error: "Rate limit exceeded" }, 429, origin);
  } catch (_) { /* fail-open */ }

  if (BEHAVIOUR_ADDR) {
    try { await ensureRpcChain(); }
    catch (err: unknown) {
      return json({ error: `RPC chain mismatch: ${err instanceof Error ? err.message : String(err)}` }, 503, origin);
    }
  }

  // Peer status check — against EVIDENCE_CONSENSUS_ADDR, the shared registry.
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
      behaviourId: behaviour_id,
      peerAddr:    peerNorm,
      phase,
      verdict,
      note: (note as string) ?? "",
    };

    let eoaOk = false;
    try {
      const recovered = ethers.verifyTypedData(buildDomain(), TYPES, message, eip712_sig as string);
      eoaOk = recovered.toLowerCase() === peerNorm;
    } catch { eoaOk = false; }

    if (!eoaOk) {
      // EIP-1271 fallback for smart-contract wallets.
      let smartOk = false;
      try {
        const digest = ethers.TypedDataEncoder.hash(buildDomain(), TYPES, message);
        const provider = getProvider();
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
  let registerEventTripleHash: string | null = null;
  if (BEHAVIOUR_ADDR && tx_hash) {
    try {
      const expectedNames: Record<string, string[]> = {
        review_vote:                ["ReviewVoteCast"],
        open_challenge:             ["ChallengeOpened"],
        challenge_vote:             ["ChallengeVoteCast"],
        finalize_challenge:         ["BehaviourDeprecated", "BehaviourReaffirmed", "BehaviourLapsed"],
        register_behaviour_onchain: ["BehaviourSubmitted"],
        mark_lapsed:                ["BehaviourLapsed"],
      };
      const names = expectedNames[String(action)] ?? [];
      if (names.length > 0) {
        const includePeer = !["finalize_challenge", "mark_lapsed"].includes(String(action));
        let expectedBool: boolean | undefined;
        if (action === "review_vote") {
          expectedBool = verdict === "approve";
        } else if (action === "challenge_vote") {
          expectedBool = verdict === "challenge";
        }
        const parsed = await verifyTxEvent(
          tx_hash as string,
          behaviour_id,
          includePeer ? peerNorm : null,
          names,
          expectedBool,
        );
        // Capture (modelHash, inputHash, outputHash) and recompute the triple
        // hash so we can compare against the off-chain row before flipping
        // submitted_onchain. Args at positions 4, 5, 6.
        if (parsed.name === "BehaviourSubmitted") {
          const m = String(parsed.args[4]).toLowerCase();
          const i = String(parsed.args[5]).toLowerCase();
          const o = String(parsed.args[6]).toLowerCase();
          registerEventTripleHash = ethers.keccak256(ethers.concat([m, i, o]));
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: `tx_hash verification failed: ${msg}` }, 401, origin);
    }
  } else if (BEHAVIOUR_ADDR && !isFinalizeAction && !isRegisterAction) {
    return json({ error: "Missing required field: tx_hash" }, 400, origin);
  } else if (BEHAVIOUR_ADDR && isRegisterAction && !tx_hash) {
    return json({ error: "register_behaviour_onchain requires tx_hash" }, 400, origin);
  } else if (BEHAVIOUR_ADDR && isFinalizeAction && !tx_hash) {
    return json({ error: "finalize_challenge requires tx_hash" }, 400, origin);
  }

  // ── Submission gate ────────────────────────────────────────────────────────
  let bhRow: {
    submitted_onchain: boolean; tier: number; domain: number;
    model_hash: string | null; input_hash: string | null; output_hash: string | null;
    model_name: string | null; model_version: string | null;
    input_payload: unknown; output_payload: unknown;
    status: string;
  } | null = null;
  if (!isFinalizeAction) {
    const { data } = await supabase
      .from("behaviour")
      .select("submitted_onchain, tier, domain, model_hash, input_hash, output_hash, model_name, model_version, input_payload, output_payload, status")
      .eq("id", behaviour_id)
      .maybeSingle();
    bhRow = (data as typeof bhRow) ?? null;
    if (!bhRow) return json({ error: "Unknown behaviour" }, 404, origin);
    if (!isRegisterAction && BEHAVIOUR_ADDR && !bhRow.submitted_onchain) {
      return json({ error: "Behaviour not yet registered on-chain" }, 409, origin);
    }
  }

  // ── Active peer count ──────────────────────────────────────────────────────
  let peerCount: number;
  try { peerCount = await fetchActivePeerCount(); }
  catch (err: unknown) {
    return json({ error: `Peer count unavailable: ${err instanceof Error ? err.message : String(err)}` }, 503, origin);
  }

  // ── Register-behaviour-onchain ─────────────────────────────────────────────
  if (isRegisterAction) {
    if (!bhRow) return json({ error: "Unknown behaviour" }, 404, origin);
    if (!bhRow.model_hash || !bhRow.input_hash || !bhRow.output_hash) {
      return json({ error: "Behaviour row missing one or more hashes" }, 409, origin);
    }

    // Payload → column check. Re-derive each component hash from the readable
    // columns and require it to match the stored hash exactly. A peer who
    // submits a fake hash on-chain that does not match their own filed
    // payload would clear the chain-vs-column check below but fail this one
    // — closing the window the audit would otherwise have caught hours
    // later. This is the "cross-check at registration" the whitepaper §10
    // claims as a non-negotiable integrity property.
    const derivedModelHash  = computeBehaviourModelHash(bhRow);
    const derivedInputHash  = computeBehaviourPayloadHash(bhRow.input_payload);
    const derivedOutputHash = computeBehaviourPayloadHash(bhRow.output_payload);
    if (derivedModelHash !== bhRow.model_hash.toLowerCase()) {
      return json({ error: "model_hash does not match re-derivation from model_name + model_version",
                    expected: derivedModelHash, stored: bhRow.model_hash }, 409, origin);
    }
    if (derivedInputHash !== bhRow.input_hash.toLowerCase()) {
      return json({ error: "input_hash does not match re-derivation from input_payload",
                    expected: derivedInputHash, stored: bhRow.input_hash }, 409, origin);
    }
    if (derivedOutputHash !== bhRow.output_hash.toLowerCase()) {
      return json({ error: "output_hash does not match re-derivation from output_payload",
                    expected: derivedOutputHash, stored: bhRow.output_hash }, 409, origin);
    }

    // Column → chain check. The triple-hash from BehaviourSubmitted event
    // must match the recomputed triple-hash of the stored columns.
    let canonical: string;
    try {
      canonical = computeTripleHash({
        model_hash:  bhRow.model_hash,
        input_hash:  bhRow.input_hash,
        output_hash: bhRow.output_hash,
      });
    } catch (err: unknown) {
      return json({ error: `Invalid hash inputs: ${err instanceof Error ? err.message : String(err)}` }, 400, origin);
    }
    if (BEHAVIOUR_ADDR && registerEventTripleHash &&
        canonical.toLowerCase() !== registerEventTripleHash.toLowerCase()) {
      return json({
        error: "Triple hash mismatch between on-chain event and stored row",
        expected: canonical, found: registerEventTripleHash,
      }, 409, origin);
    }

    await supabase.from("behaviour").update({
      submitted_onchain:    true,
      submitted_onchain_at: new Date().toISOString(),
      submission_tx_hash:   tx_hash,
    }).eq("id", behaviour_id);
    return json({ ok: true, submitted_onchain: true, triple_hash: canonical }, 200, origin);
  }

  // ── Write attestation ──────────────────────────────────────────────────────
  if (!isFinalizeAction) {
    const { error: attErr } = await supabase.from("behaviour_attestations").upsert(
      {
        behaviour_id,
        peer_addr:   peerNorm,
        peer_handle: peer_handle ?? null,
        phase,
        verdict,
        note:        note ?? null,
        eip712_sig:  eip712_sig ?? null,
        tx_hash:     tx_hash ?? null,
      },
      { onConflict: "behaviour_id,peer_addr,phase" },
    );
    if (attErr) return json({ error: attErr.message }, 500, origin);
  }

  // ── Status update ──────────────────────────────────────────────────────────
  const extra: Record<string, unknown> = {};

  if (action === "review_vote") {
    const bhTier = bhRow?.tier ?? (tier as number | null) ?? 2;
    const { data: applied, error: applyErr } = await supabase.rpc("apply_behaviour_review_counts", {
      p_behaviour_id: behaviour_id,
      p_canon_thresh: canonizeThreshold(bhTier, peerCount),
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
    const curStatus = bhRow?.status;
    const bhTier    = bhRow?.tier ?? 2;

    if (curStatus === "aligned" || curStatus === "reaffirmed") {
      await supabase.from("behaviour").update({
        status:              "contested",
        challenged_at:       new Date().toISOString(),
        challenge_reason:    challenge_reason ?? null,
        challenge_votes:     1,
        defense_votes:       0,
        challenge_threshold: deprecateThreshold(bhTier, peerCount),
      }).eq("id", behaviour_id);
      Object.assign(extra, { status: "contested" });
    } else if (curStatus === "contested") {
      await supabase.from("behaviour").update({
        challenge_reason:    challenge_reason ?? null,
        challenge_votes:     1,
        defense_votes:       0,
        challenge_threshold: deprecateThreshold(bhTier, peerCount),
      }).eq("id", behaviour_id);
      Object.assign(extra, { status: "contested" });
    } else {
      Object.assign(extra, { status: curStatus });
    }

  } else if (action === "challenge_vote") {
    const bhTier = bhRow?.tier ?? 2;
    const { data: applied, error: applyErr } = await supabase.rpc("apply_behaviour_challenge_counts", {
      p_behaviour_id:  behaviour_id,
      p_deprec_thresh: deprecateThreshold(bhTier, peerCount),
    });
    if (applyErr) return json({ error: applyErr.message }, 500, origin);
    const row = Array.isArray(applied) ? applied[0] : applied;
    Object.assign(extra, {
      challenge_votes: row?.challenge_votes ?? 0,
      defense_votes:   row?.defense_votes   ?? 0,
      status:          row?.status ?? null,
    });

  } else if (isFinalizeAction) {
    const { data: bh } = await supabase
      .from("behaviour")
      .select("tier, status, challenged_at, challenge_reason")
      .eq("id", behaviour_id).single();

    type BhRow = { tier?: number; status?: string; challenged_at?: string; challenge_reason?: string };
    const bhData = (bh as BhRow | null) ?? {};

    if (bhData.status !== "contested") return json({ error: "Behaviour is not contested" }, 400, origin);
    const elapsed = bhData.challenged_at
      ? Date.now() - new Date(bhData.challenged_at).getTime()
      : Infinity;
    if (elapsed < CHALLENGE_WINDOW_MS) return json({ error: "Challenge window is still open" }, 400, origin);

    const { data: atts } = await supabase
      .from("behaviour_attestations").select("verdict")
      .eq("behaviour_id", behaviour_id).eq("phase", "challenge");

    const challengeVotes = (atts ?? []).filter((a: { verdict: string }) => a.verdict === "challenge").length;
    const defenseVotes   = (atts ?? []).filter((a: { verdict: string }) => a.verdict === "defend").length;
    const bhTier         = bhData.tier ?? 2;

    if (challengeVotes >= deprecateThreshold(bhTier, peerCount)) {
      await supabase.from("behaviour").update({
        status:            "deprecated",
        deprecated_at:     new Date().toISOString(),
        deprecated_reason: bhData.challenge_reason ?? null,
      }).eq("id", behaviour_id);
      Object.assign(extra, { status: "deprecated" });
    } else {
      await supabase.from("behaviour").update({ status: "reaffirmed" }).eq("id", behaviour_id);
      Object.assign(extra, { status: "reaffirmed", challenge_votes: challengeVotes, defense_votes: defenseVotes });
    }
  }

  return json({ ok: true, verified: !!eip712_sig, ...extra }, 200, origin);
});
