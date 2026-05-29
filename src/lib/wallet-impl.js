/**
 * Heavy ethers-dependent half of the wallet client.  Imported lazily by
 * src/lib/wallet.js the first time a caller actually needs a chain read or
 * write.  Until then the page can render without paying the ~155 KB-gzip
 * cost of ethers v6 — typical /evidence/ visitors and the connect-screen
 * frame of /peer-review/ never trigger the import.
 *
 * Keep this module ethers-only — no React, no Supabase.  Public API mirrors
 * the names re-exported by wallet.js.
 */
import { AbiCoder, BrowserProvider, Contract, Interface, JsonRpcProvider, keccak256, toUtf8Bytes, verifyTypedData, ZeroHash } from 'ethers';
import {
  CONSENSUS_ADDR, CONSENSUS_ABI, CONSENSUS_CHAIN_ID,
  CONSENSUS_LENS_ADDR, CONSENSUS_LENS_ABI,
  CONTENT_ARCHIVE_ADDR, ARCHIVE_ABI,
  CONSENSUS_GOVERNANCE_ADDR, GOVERNANCE_ABI,
  MULTICALL3_ADDR, MULTICALL3_ABI,
  ATTESTATION_DOMAIN, ATTESTATION_TYPES, VOTE_TYPES, VOTE_PHASE, FORCE_RENOUNCE_ID,
  PEER_GOVERNANCE_DOMAIN, PEER_VOTE_TYPES, PEER_VOTE_KIND,
} from './wallet-constants';

const TARGET_CHAIN_ID_HEX = '0x' + CONSENSUS_CHAIN_ID.toString(16);

export const IFACE             = new Interface(CONSENSUS_ABI);
const GOVERNANCE_IFACE         = new Interface(GOVERNANCE_ABI);
const MULTICALL3_IFACE         = new Interface(MULTICALL3_ABI);
const MULTICALL3_CHUNK         = 200;

// ── Provider helpers ────────────────────────────────────────────────────────

let _browserProvider = null;
function getBrowserProvider() {
  if (!window.ethereum) throw new Error('MetaMask not found');
  if (!_browserProvider) _browserProvider = new BrowserProvider(window.ethereum, 'any');
  return _browserProvider;
}

// CORS-enabled public RPCs so read-only calls (peer count, thresholds) work for
// wallet-less visitors even when VITE_CONSENSUS_READ_RPC is unset in the deploy
// env — the local .env is gitignored, so a Netlify build can lack it, which
// would otherwise force every public read onto MetaMask and fail (→ "—").
const FALLBACK_READ_RPC = {
  56: 'https://bsc-rpc.publicnode.com',
  97: 'https://bsc-testnet-rpc.publicnode.com',
};
const READ_RPC = import.meta.env.VITE_CONSENSUS_READ_RPC || FALLBACK_READ_RPC[CONSENSUS_CHAIN_ID] || null;
let _readProvider = null;
function getReadProvider() {
  if (READ_RPC) {
    if (!_readProvider) _readProvider = new JsonRpcProvider(READ_RPC);
    return _readProvider;
  }
  return getBrowserProvider();
}

function readContract() {
  if (!CONSENSUS_ADDR) throw new Error('VITE_CONSENSUS_ADDR not set');
  return new Contract(CONSENSUS_ADDR, CONSENSUS_ABI, getReadProvider());
}

// Read-only Lens sidecar (peer/nominee/proposal aggregation views moved off the
// core for EIP-170 headroom).
function lensContract() {
  if (!CONSENSUS_LENS_ADDR) throw new Error('VITE_CONSENSUS_LENS_ADDR not set');
  return new Contract(CONSENSUS_LENS_ADDR, CONSENSUS_LENS_ABI, getReadProvider());
}

async function writeContract() {
  if (!CONSENSUS_ADDR) throw new Error('VITE_CONSENSUS_ADDR not set');
  const signer = await getBrowserProvider().getSigner();
  return new Contract(CONSENSUS_ADDR, CONSENSUS_ABI, signer);
}

// PeerGovernance sidecar — the nominee + revocation flows (and their views)
// moved off the core for EIP-170 headroom.
function govContract() {
  if (!CONSENSUS_GOVERNANCE_ADDR) throw new Error('VITE_CONSENSUS_GOVERNANCE_ADDR not set');
  return new Contract(CONSENSUS_GOVERNANCE_ADDR, GOVERNANCE_ABI, getReadProvider());
}
async function govWriteContract() {
  if (!CONSENSUS_GOVERNANCE_ADDR) throw new Error('VITE_CONSENSUS_GOVERNANCE_ADDR not set');
  const signer = await getBrowserProvider().getSigner();
  return new Contract(CONSENSUS_GOVERNANCE_ADDR, GOVERNANCE_ABI, signer);
}

// ── UUID ↔ bytes32 ──────────────────────────────────────────────────────────

export function uuidToBytes32(uuid) {
  const hex = uuid.replace(/-/g, '');
  return '0x' + hex.padStart(64, '0');
}
export function bytes32ToUuid(hex32) {
  const h = hex32.replace(/^0x/, '').replace(/^0+/, '').padStart(32, '0');
  return [h.slice(0,8), h.slice(8,12), h.slice(12,16), h.slice(16,20), h.slice(20)].join('-');
}

// ── Content hash ────────────────────────────────────────────────────────────
//
// Binds the evidence CONTENT only.  An evidence can be cross-listed under any
// number of (pillar → topic) bindings without changing its hash, so topic_id is
// deliberately NOT part of the canonical payload.  Must stay byte-identical with
// the `audit-content-hash` / `verify-attestation` edge functions.

// The canonical content string is the SINGLE source of truth for both the hash
// and what gets published on-chain to EvidenceArchive — publish this exact string
// (not a re-stringify) so `keccak256(string) == contentHash` holds on-chain.
export function canonicalContentJSON({ title, source, year, excerpt, link, tier }) {
  return JSON.stringify({
    title:   String(title ?? '').trim(),
    source:  String(source ?? '').trim(),
    year:    String(year ?? '').trim(),
    excerpt: String(excerpt ?? '').trim(),
    link:    String(link ?? '').trim(),
    tier:    Number(tier),
  });
}
export function computeContentHash(content) {
  return keccak256(toUtf8Bytes(canonicalContentJSON(content)));
}

// ── Attestation signature recovery ───────────────────────────────────────────
//
// Pure client-side proof of authorship. The server's verify-attestation edge
// function already recovered the signer when the vote was recorded, but that is
// a *trusted* check. This lets a visitor re-run the exact same EIP-712 recovery
// in their own browser over the public (domain, types, message, signature) and
// confirm the named peer — not the platform — authored the vote. Returns the
// recovered EOA address; the caller compares it (case-insensitively) to the
// claimed peer_addr. The domain/types are shared with `signAttestation`, so this
// matches the original signature byte-for-byte.
export function recoverAttestationSigner({ message, signature }) {
  return verifyTypedData(ATTESTATION_DOMAIN, ATTESTATION_TYPES, message, signature);
}

// ── Binding id ────────────────────────────────────────────────────────────────
//
// Mirrors EvidenceConsensus.bindingId(id, topicId) = keccak256(abi.encode(...)).
// `topicId` is the on-chain bytes32 (slugToBytes32(slug)).
const _abi = AbiCoder.defaultAbiCoder();
export function bindingKey(uuid, topicId) {
  return keccak256(_abi.encode(['bytes32', 'bytes32'], [uuidToBytes32(uuid), topicId]));
}

// ── Taxonomy hashes ──────────────────────────────────────────────────────────
//
// A taxonomy node's on-chain id is keccak256(slug); its metadata is committed
// as keccak256(canonical JSON).  These MUST match blockchain/scripts/
// taxonomy-baseline.js so seeded baseline nodes and future UI proposals share
// the same hashes (the indexer joins off-chain rows by node_hash).

export function slugToBytes32(slug) {
  return keccak256(toUtf8Bytes(String(slug)));
}

// As with content: this exact string is both hashed AND published on-chain to
// EvidenceArchive, so a wipe can recover the readable node metadata verbatim.
export function canonicalMetaJSON({ kind, slug, parent, title, blurb, tag }) {
  return JSON.stringify({
    kind:   String(kind),
    slug:   String(slug ?? '').trim(),
    parent: String(parent ?? '').trim(),
    title:  String(title ?? '').trim(),
    blurb:  String(blurb ?? '').trim(),
    tag:    String(tag ?? '').trim(),
  });
}
export function computeMetaHash(meta) {
  return keccak256(toUtf8Bytes(canonicalMetaJSON(meta)));
}

// ── Wallet ──────────────────────────────────────────────────────────────────

export async function connectWallet() {
  if (!window.ethereum) throw new Error('MetaMask not found');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const addr     = accounts[0];
  const chainId  = await window.ethereum.request({ method: 'eth_chainId' });
  return { addr, chainId };
}

export async function switchToTargetChain() {
  if (!window.ethereum) return;
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: TARGET_CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err.code === 4902) {
      const isTestnet = CONSENSUS_CHAIN_ID === 97;
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: TARGET_CHAIN_ID_HEX,
          chainName: isTestnet ? 'BNB Smart Chain Testnet' : 'BNB Smart Chain',
          nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
          rpcUrls: isTestnet
            ? ['https://data-seed-prebsc-1-s1.binance.org:8545/']
            : ['https://bsc-dataseed.binance.org/'],
          blockExplorerUrls: isTestnet
            ? ['https://testnet.bscscan.com']
            : ['https://bscscan.com'],
        }],
      });
    }
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

function safe(fn, fallback) {
  return async (...args) => {
    try { return await fn(...args); } catch { return fallback; }
  };
}

export const getActivePeerCount       = safe(async ()           => Number(await readContract().activePeerCount()), null);
export const isPeerActive             = safe(async (addr)       => await readContract().isActivePeer(addr), false);
export const isGenesisPeer            = safe(async (addr)       => await lensContract().isGenesisPeer(addr), false);
export const getLastActive            = safe(async (addr)       => Number(await readContract().lastActive(addr)), 0);
export const getReviewCapacity        = safe(async ()           => Number(await readContract().reviewCapacity()), 0);
export const getActiveReviewCount     = safe(async ()           => Number(await readContract().activeReviewCount()), 0);
export const getPeerHandle            = safe(async (addr)       => await readContract().peerHandle(addr), '');
export const getNomineeThreshold      = safe(async ()           => Number(await govContract().nomineeThreshold()), 1);
export const getRevokeThreshold       = safe(async ()           => Number(await govContract().revokeThreshold()), 1);
export const isNomineeAddress         = safe(async (addr)       => await govContract().isNominated(addr), false);
export const getNomineeEndorsements   = safe(async (addr)       => Number(await govContract().nomineeEndorsements(addr)), 0);
export const getNomineeRound           = safe(async (addr)       => Number(await govContract().nomineeRound(addr)), 0);
export const hasEndorsedNominee       = safe(async (nom, from)  => await govContract().hasEndorsed(nom, from), false);
export const getNomineeHandle         = safe(async (addr)       => await govContract().nomineeHandle(addr), '');
export const isRevocationActive       = safe(async (addr)       => await govContract().revocationActive(addr), false);
export const getRevokeRound           = safe(async (addr)       => Number(await govContract().revokeRound(addr)), 0);
export const getRevokeVoteCount       = safe(async (addr)       => Number(await govContract().revokeVoteCount(addr)), 0);
export const hasVotedForRevoke        = safe(async (t, v)       => await govContract().hasVotedRevoke(t, v), false);
export const getChallengeCooldownRemaining = safe(async (addr)  => Number(await lensContract().challengeCooldownRemaining(addr)), 0);
export const getBoostCooldownRemaining     = safe(async (addr)  => Number(await lensContract().boostCooldownRemaining(addr)), 0);
export const isNominationsOpen        = safe(async ()           => await govContract().nominationsOpen(), false);
export const getSeedPhaseK            = safe(async ()           => Number(await readContract().seedPhaseK()), 0);
export const getOwner                 = safe(async ()           => await readContract().owner(), null);
export const getForceRenounceActive   = safe(async ()           => await readContract().forceRenounceActive(), false);
export const getForceRenounceVotes    = safe(async ()           => Number(await readContract().forceRenounceVotes()), 0);

export async function hasVotedOnChain(uuid, topicId, phase, addr) {
  try { return await readContract().hasVoted(bindingKey(uuid, topicId), phase, addr); }
  catch { return false; }
}

// Read an (evidence × topic) binding straight from chain.
export async function getBindingOnChain(uuid, topicId) {
  try { return await readContract().getBinding(uuidToBytes32(uuid), topicId); }
  catch { return null; }
}

// ── Multicall3 ─────────────────────────────────────────────────────────────

async function multicallAggregate3(calls) {
  if (!calls.length) return [];
  const provider = getReadProvider();
  const out = [];
  for (let i = 0; i < calls.length; i += MULTICALL3_CHUNK) {
    const chunk = calls.slice(i, i + MULTICALL3_CHUNK);
    const data = MULTICALL3_IFACE.encodeFunctionData('aggregate3', [
      chunk.map(c => ({ target: c.target, allowFailure: true, callData: c.callData })),
    ]);
    const raw = await provider.call({ to: MULTICALL3_ADDR, data });
    const [results] = MULTICALL3_IFACE.decodeFunctionResult('aggregate3', raw);
    for (const r of results) out.push({ success: r.success, returnData: r.returnData });
  }
  return out;
}

// `bindings` is an array of { key, uuid, topicId } where key is the caller's
// map key (typically the off-chain binding id) and topicId is the on-chain
// bytes32 topic. Returns Map<key, boolean> of whether `addr` has voted.
export async function hasVotedManyOnChain(bindings, phase, addr) {
  if (!CONSENSUS_ADDR || !bindings.length) return new Map();
  const calls = bindings.map(b => ({
    target:   CONSENSUS_ADDR,
    callData: IFACE.encodeFunctionData('hasVoted', [bindingKey(b.uuid, b.topicId), phase, addr]),
  }));
  try {
    const results = await multicallAggregate3(calls);
    const out = new Map();
    results.forEach((r, i) => {
      let v = false;
      if (r.success) {
        try { [v] = IFACE.decodeFunctionResult('hasVoted', r.returnData); } catch { v = false; }
      }
      out.set(bindings[i].key, !!v);
    });
    return out;
  } catch {
    return new Map(bindings.map(b => [b.key, false]));
  }
}

export async function hasVotedForRevokeMany(peerAddrs, voterAddr) {
  if (!CONSENSUS_GOVERNANCE_ADDR || !peerAddrs.length) return new Map();
  const calls = peerAddrs.map(p => ({
    target:   CONSENSUS_GOVERNANCE_ADDR,
    callData: GOVERNANCE_IFACE.encodeFunctionData('hasVotedRevoke', [p, voterAddr]),
  }));
  try {
    const results = await multicallAggregate3(calls);
    const out = new Map();
    results.forEach((r, i) => {
      let v = false;
      if (r.success) {
        try { [v] = GOVERNANCE_IFACE.decodeFunctionResult('hasVotedRevoke', r.returnData); } catch { v = false; }
      }
      out.set(peerAddrs[i].toLowerCase(), !!v);
    });
    return out;
  } catch {
    return new Map(peerAddrs.map(p => [p.toLowerCase(), false]));
  }
}

// Aggregated peer / nominee views — single eth_call each, served by the Lens.
export async function getActivePeersAggregated() {
  try {
    const [addrs, handles, revActive, revVotes, lastActives] = await lensContract().getActivePeers();
    return addrs.map((a, i) => ({
      addr:       a.toLowerCase(),
      handle:     handles[i] ?? '',
      revActive:  revActive[i] ?? false,
      revVotes:   Number(revVotes[i] ?? 0),
      lastActive: Number(lastActives[i] ?? 0),
    }));
  } catch { return []; }
}

export async function getNomineesAggregated() {
  try {
    const [addrs, handles, endorsements] = await lensContract().getNominees();
    return addrs.map((a, i) => ({
      addr:         a.toLowerCase(),
      handle:       handles[i] ?? '',
      endorsements: Number(endorsements[i] ?? 0),
    }));
  } catch { return []; }
}

export async function getPeerList() {
  try {
    const list = await readContract().peerList();
    return list.map(a => a.toLowerCase());
  } catch { return []; }
}
export async function getNomineeList() {
  try {
    const list = await govContract().nomineeList();
    return list.map(a => a.toLowerCase());
  } catch { return []; }
}

// ── Taxonomy reads ───────────────────────────────────────────────────────────

export const getTaxonomyThreshold = safe(async () => Number(await readContract().taxonomyThreshold()), 1);
export const getRetireThreshold   = safe(async () => Number(await readContract().retireThreshold()), 1);
export const hasEndorsedNode      = safe(async (id, addr) => await readContract().hasEndorsedNode(id, addr), false);
export const isRetireActive       = safe(async (id) => await readContract().retireActive(id), false);
export const getRetireVoteCount   = safe(async (id) => Number(await readContract().retireVotes(id)), 0);
export const getRetireMotionAt    = safe(async (id) => Number(await readContract().retireMotionAt(id)), 0);
export const hasVotedForRetire    = safe(async (id, voter) => await readContract().hasVotedRetire(id, voter), false);

// Ratified pillars — bytes32 ids + metadata hashes (matched to off-chain rows by node_hash).
export async function getPillarsAggregated() {
  try {
    const [ids, metaHashes] = await readContract().getPillars();
    return ids.map((id, i) => ({ id: id.toLowerCase(), metaHash: (metaHashes[i] ?? '').toLowerCase() }));
  } catch { return []; }
}

// Ratified topics under a pillar (pillar passed as a bytes32 node id).
export async function getTopicsAggregated(pillarId) {
  try {
    const [ids, metaHashes] = await readContract().getTopics(pillarId);
    return ids.map((id, i) => ({ id: id.toLowerCase(), metaHash: (metaHashes[i] ?? '').toLowerCase() }));
  } catch { return []; }
}

// Pending pillar/topic proposals with live endorsement counts (Lens view).
export async function getProposedNodesAggregated() {
  try {
    const [ids, kinds, parents, metaHashes, proposers, endorsements, rejections] = await lensContract().getProposedNodes();
    return ids.map((id, i) => ({
      id:           id.toLowerCase(),
      kind:         Number(kinds[i]),               // 0 = pillar, 1 = topic
      parent:       (parents[i] ?? '').toLowerCase(),
      metaHash:     (metaHashes[i] ?? '').toLowerCase(),
      proposer:     (proposers[i] ?? '').toLowerCase(),
      endorsements: Number(endorsements[i] ?? 0),
      rejections:   Number(rejections?.[i] ?? 0),
    }));
  } catch { return []; }
}

// ── Writes ──────────────────────────────────────────────────────────────────

async function sendTx(fnName, args) {
  const c  = await writeContract();
  const tx = await c[fnName](...args);
  return tx.hash;
}

// Same as sendTx but against the PeerGovernance sidecar (nominee + revocation).
async function sendGovTx(fnName, args) {
  const c  = await govWriteContract();
  const tx = await c[fnName](...args);
  return tx.hash;
}

// ── EIP-712 Vote signing ──────────────────────────────────────────────────────
//
// Review / challenge votes are authorised by an on-chain-recovered EIP-712
// signature, so signing is folded into the vote write below. The domain is the
// same one verify-attestation uses (verifyingContract = CONSENSUS_ADDR, which is
// always set when an on-chain vote is possible). noteHash binds the deliberation
// note; round binds the binding's current review/challenge round (anti-replay).
function noteHashOf(note) {
  const s = String(note ?? '');
  return s.length ? keccak256(toUtf8Bytes(s)) : ZeroHash;
}
async function signVote({ bindingId, phase, support, round, noteHash }) {
  const signer = await getBrowserProvider().getSigner();
  return signer.signTypedData(ATTESTATION_DOMAIN, VOTE_TYPES, { bindingId, phase, support, round, noteHash });
}

// Sign a Vote WITHOUT broadcasting a tx — used by the dev-mode (no CONSENSUS_ADDR)
// path so an off-chain attestation still carries a verifiable Vote signature.
// round is read from chain when a contract is configured, else 0.
// phase: 0 = review, 1 = challenge. Returns { sig, noteHash, round, bindingHash }.
export async function signVoteOnly(uuid, topicId, phase, support, note = '') {
  const bindingHash = bindingKey(uuid, topicId);
  let round = 0;
  if (CONSENSUS_ADDR) {
    const b = await readContract().getBinding(uuidToBytes32(uuid), topicId);
    round = phase === 1 ? Number(b.challengeRound) : Number(b.reviewRound);
  }
  const noteHash = noteHashOf(note);
  const sig = await signVote({ bindingId: bindingHash, phase, support, round, noteHash });
  return { sig, noteHash, round, bindingHash };
}

// Sign a PeerVote(subject, kind, support, round, noteHash) — recovered ON-CHAIN
// by PeerGovernance, so the domain is the governance sidecar's own. kind: 0 =
// nominee endorse, 1 = revocation discard. support is always true.
async function signPeerVote({ subject, kind, support, round, noteHash }) {
  const signer = await getBrowserProvider().getSigner();
  return signer.signTypedData(PEER_GOVERNANCE_DOMAIN, PEER_VOTE_TYPES, { subject, kind, support, round, noteHash });
}

// Nominee + revocation governance — target the PeerGovernance sidecar. nominate
// / lapse / cancelStale are not votes (plain calls). The membership VOTES —
// endorseNominee, motionRevoke, voteRevoke — are by-signature: they sign a
// PeerVote (bound to the subject's current round + the note hash) and submit it,
// returning { txHash, sig, noteHash, round } so the off-chain writer can persist
// the SAME signature + note the chain verified.
// Nominate is the nominator's own signed act (PeerVote kind 2), bound to the
// round this nomination mints (current + 1). Returns { txHash, sig, noteHash,
// round } so the off-chain writer can persist the same note + signature.
export async function nominatePeer(nominee, handle, note = '') {
  const round    = Number(await govContract().nomineeRound(nominee)) + 1;
  const noteHash = noteHashOf(note);
  const sig      = await signPeerVote({ subject: nominee, kind: PEER_VOTE_KIND.nominate, support: true, round, noteHash });
  const c  = await govWriteContract();
  const tx = await c.nominatePeer(nominee, handle, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}
export async function lapseNominee(nominee)                    { return sendGovTx('lapseNominee', [nominee]); }
export async function cancelStaleRevocation(peer)             { return sendGovTx('cancelStaleRevocation', [peer]); }

export async function endorseNominee(nominee, note = '') {
  const round    = Number(await govContract().nomineeRound(nominee));
  const noteHash = noteHashOf(note);
  const sig      = await signPeerVote({ subject: nominee, kind: PEER_VOTE_KIND.nominee, support: true, round, noteHash });
  const c  = await govWriteContract();
  const tx = await c.endorseNominee(nominee, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}
// A motion opens the new round AND casts discard vote #1, so it signs round+1.
export async function motionRevoke(peer, note = '') {
  const round    = Number(await govContract().revokeRound(peer)) + 1;
  const noteHash = noteHashOf(note);
  const sig      = await signPeerVote({ subject: peer, kind: PEER_VOTE_KIND.revoke, support: true, round, noteHash });
  const c  = await govWriteContract();
  const tx = await c.motionRevoke(peer, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}
export async function voteRevoke(peer, note = '') {
  const round    = Number(await govContract().revokeRound(peer));
  const noteHash = noteHashOf(note);
  const sig      = await signPeerVote({ subject: peer, kind: PEER_VOTE_KIND.revoke, support: true, round, noteHash });
  const c  = await govWriteContract();
  const tx = await c.voteRevoke(peer, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}
// Owner-only, seed-phase only (activePeerCount < seedPhaseK): seed a founding
// peer directly on the CORE. Once the count reaches seedPhaseK the open
// nominate→endorse flow (governance) takes over and addPeer reverts.
export async function addPeer(peer, handle)                    { return sendTx('addPeer', [peer, handle]); }
export async function heartbeatOnChain()                       { return sendTx('heartbeat', []); }
export async function pruneInactivePeerOnChain(peer)           { return sendTx('pruneInactivePeer', [peer]); }
// Peer supermajority (2/3) eviction of a captured/paused owner. By-signature
// (Vote phase 4 over a fixed sentinel id). A motion mints round+1; a vote signs
// the current round. Returns { txHash, sig, noteHash, round } for off-chain note.
const FORCE_RENOUNCE_BID = slugToBytes32(FORCE_RENOUNCE_ID);
export async function motionForceRenounce(note = '') {
  const round    = Number(await readContract().forceRenounceRound()) + 1;
  const noteHash = noteHashOf(note);
  const sig      = await signVote({ bindingId: FORCE_RENOUNCE_BID, phase: VOTE_PHASE.forceRenounce, support: true, round, noteHash });
  const c  = await writeContract();
  const tx = await c.motionForceRenounce(noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round, bindingHash: FORCE_RENOUNCE_BID };
}
export async function voteForceRenounce(note = '') {
  const round    = Number(await readContract().forceRenounceRound());
  const noteHash = noteHashOf(note);
  const sig      = await signVote({ bindingId: FORCE_RENOUNCE_BID, phase: VOTE_PHASE.forceRenounce, support: true, round, noteHash });
  const c  = await writeContract();
  const tx = await c.voteForceRenounce(noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round, bindingHash: FORCE_RENOUNCE_BID };
}

// Taxonomy governance. node ids are bytes32 = slugToBytes32(slug); metaHash from
// computeMetaHash(). Every node is bootstrapped with a founding evidence: a
// pillar bundles its first topic + evidence, a topic bundles its first evidence.
// `evidenceUuid` is the off-chain evidence UUID (encoded to bytes32 here);
// `contentHash` is computeContentHash() of that evidence.
// Taxonomy propose/endorse are Vote-by-signature (phase 2; bindingId = node id).
// The proposer is endorsement #1, so a propose signs the round it mints
// (current + 1); an endorse signs the node's current round. All return
// { txHash, sig, noteHash, round } so the off-chain endorsement record can
// persist the same note + signature the chain recovered.
export async function proposePillarOnChain(id, metaHash, topicId, topicMetaHash, evidenceUuid, tier, contentHash, note = '') {
  const round    = Number(await readContract().nodeRound(id)) + 1;
  const noteHash = noteHashOf(note);
  const sig      = await signVote({ bindingId: id, phase: VOTE_PHASE.taxonomy, support: true, round, noteHash });
  const c  = await writeContract();
  const tx = await c.proposePillar(id, metaHash, topicId, topicMetaHash, uuidToBytes32(evidenceUuid), tier, contentHash, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}
export async function proposeTopicOnChain(id, parentPillar, metaHash, evidenceUuid, tier, contentHash, note = '') {
  const round    = Number(await readContract().nodeRound(id)) + 1;
  const noteHash = noteHashOf(note);
  const sig      = await signVote({ bindingId: id, phase: VOTE_PHASE.taxonomy, support: true, round, noteHash });
  const c  = await writeContract();
  const tx = await c.proposeTopic(id, parentPillar, metaHash, uuidToBytes32(evidenceUuid), tier, contentHash, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}
export async function endorseNodeOnChain(id, note = '') {
  const round    = Number(await readContract().nodeRound(id));
  const noteHash = noteHashOf(note);
  const sig      = await signVote({ bindingId: id, phase: VOTE_PHASE.taxonomy, support: true, round, noteHash });
  const c  = await writeContract();
  const tx = await c.endorseNode(id, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}
// Reject is the dissent mirror of endorse: the SAME Vote (phase 2, current round)
// but support=false. The moment rejections make ratification impossible the
// contract settles the node as terminal Rejected; otherwise it just adds to the
// dissent tally. Returns { txHash, sig, noteHash, round } so the off-chain record
// persists the same note + signature the chain recovered.
export async function rejectNodeOnChain(id, note = '') {
  const round    = Number(await readContract().nodeRound(id));
  const noteHash = noteHashOf(note);
  const sig      = await signVote({ bindingId: id, phase: VOTE_PHASE.taxonomy, support: false, round, noteHash });
  const c  = await writeContract();
  const tx = await c.rejectNode(id, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}

// Taxonomy retirement (ratified-node governance). `id` is the bytes32 node id.
// Vote-by-signature (phase 3); motion mints round+1, vote signs current round.
export async function motionRetireNodeOnChain(id, note = '') {
  const round    = Number(await readContract().retireRound(id)) + 1;
  const noteHash = noteHashOf(note);
  const sig      = await signVote({ bindingId: id, phase: VOTE_PHASE.retire, support: true, round, noteHash });
  const c  = await writeContract();
  const tx = await c.motionRetireNode(id, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}
export async function voteRetireNodeOnChain(id, note = '') {
  const round    = Number(await readContract().retireRound(id));
  const noteHash = noteHashOf(note);
  const sig      = await signVote({ bindingId: id, phase: VOTE_PHASE.retire, support: true, round, noteHash });
  const c  = await writeContract();
  const tx = await c.voteRetireNode(id, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round };
}
export async function cancelStaleRetireOnChain(id)                  { return sendTx('cancelStaleRetire', [id]); }

export async function submitEvidenceOnChain(uuid, tier, topicId, ch) { return sendTx('submitEvidence', [uuidToBytes32(uuid), tier, topicId, ch]); }
export async function fileBindingOnChain(uuid, topicId)        { return sendTx('fileBinding', [uuidToBytes32(uuid), topicId]); }

// ── EvidenceArchive: publish readable strings on-chain ───────────────────────
//
// The core commits only hashes; these push the actual content / metadata / note
// text to the EvidenceArchive sidecar (each verified on-chain against the core's
// hash) so the chain is a complete backup and Supabase is a disposable
// projection. All are permissionless and idempotent — safe to retry / backfill.
async function archiveWriteContract() {
  if (!CONTENT_ARCHIVE_ADDR) throw new Error('VITE_CONTENT_ARCHIVE_ADDR not set');
  const signer = await getBrowserProvider().getSigner();
  return new Contract(CONTENT_ARCHIVE_ADDR, ARCHIVE_ABI, signer);
}

// `content` = { title, source, year, excerpt, link, tier } (hash-bound);
// `extra`   = { type, tags } (not hash-bound, stored as-is for a full rebuild).
export async function publishEvidenceContentOnChain(uuid, content, extra = {}) {
  const c  = await archiveWriteContract();
  const tx = await c.publishEvidenceContent(uuidToBytes32(uuid), canonicalContentJSON(content), JSON.stringify(extra ?? {}));
  return tx.hash;
}

// `nodeId` is the bytes32 slug hash (slugToBytes32(slug)); `meta` =
// { kind, slug, parent, title, blurb, tag }.
export async function publishNodeMetaOnChain(nodeId, meta) {
  const c  = await archiveWriteContract();
  const tx = await c.publishNodeMeta(nodeId, canonicalMetaJSON(meta));
  return tx.hash;
}

// Publishes a deliberation note's text, keyed on-chain by keccak256(text) — the
// same noteHash the signed vote committed. Empty notes have no recoverable text
// (their noteHash is the ZeroHash sentinel), so this no-ops on them.
export async function publishNoteOnChain(text) {
  const s = String(text ?? '');
  if (!s.length) return null;
  const c  = await archiveWriteContract();
  const tx = await c.publishNote(s);
  return tx.hash;
}

export async function publishNotesOnChain(texts) {
  const list = (texts || []).map(t => String(t ?? '')).filter(s => s.length);
  if (!list.length) return null;
  const c  = await archiveWriteContract();
  const tx = await c.publishNotes(list);
  return tx.hash;
}
// Vote writes are by-signature: they sign the EIP-712 Vote (bound to the
// binding's current round + the note hash) and submit it. They return
// { txHash, sig, noteHash, round, bindingHash } so the off-chain writer can
// persist the SAME signature the chain recovered.
export async function castReviewVoteOnChain(uuid, topicId, approve, note = '') {
  const bindingHash = bindingKey(uuid, topicId);
  const round       = Number((await readContract().getBinding(uuidToBytes32(uuid), topicId)).reviewRound);
  const noteHash    = noteHashOf(note);
  const sig         = await signVote({ bindingId: bindingHash, phase: 0, support: approve, round, noteHash });
  const c  = await writeContract();
  const tx = await c.castReviewVote(uuidToBytes32(uuid), topicId, approve, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round, bindingHash };
}
export async function castReviewVoteBatchOnChain(uuids, topicIds, aprs) {
  if (![uuids, topicIds, aprs].every(Array.isArray) || uuids.length !== aprs.length || uuids.length !== topicIds.length) {
    throw new Error('Batch arrays must be same length');
  }
  const rc = readContract();
  const items = [];
  for (let i = 0; i < uuids.length; i++) {
    const bindingHash = bindingKey(uuids[i], topicIds[i]);
    const round       = Number((await rc.getBinding(uuidToBytes32(uuids[i]), topicIds[i])).reviewRound);
    const sig         = await signVote({ bindingId: bindingHash, phase: 0, support: aprs[i], round, noteHash: ZeroHash });
    items.push({ bindingHash, round, noteHash: ZeroHash, sig });
  }
  const c  = await writeContract();
  const tx = await c.castReviewVoteBatch(uuids.map(uuidToBytes32), topicIds, aprs, items.map(() => ZeroHash), items.map(it => it.sig));
  return { txHash: tx.hash, items };
}
export async function openChallengeOnChain(uuid, topicId, note = '') {
  const bindingHash = bindingKey(uuid, topicId);
  const round       = Number((await readContract().getBinding(uuidToBytes32(uuid), topicId)).challengeRound) + 1; // open creates round+1
  const noteHash    = noteHashOf(note);
  const sig         = await signVote({ bindingId: bindingHash, phase: 1, support: true, round, noteHash });
  const c  = await writeContract();
  const tx = await c.openChallenge(uuidToBytes32(uuid), topicId, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round, bindingHash };
}
export async function castChallengeVoteOnChain(uuid, topicId, support, note = '') {
  const bindingHash = bindingKey(uuid, topicId);
  const round       = Number((await readContract().getBinding(uuidToBytes32(uuid), topicId)).challengeRound);
  const noteHash    = noteHashOf(note);
  const sig         = await signVote({ bindingId: bindingHash, phase: 1, support, round, noteHash });
  const c  = await writeContract();
  const tx = await c.castChallengeVote(uuidToBytes32(uuid), topicId, support, noteHash, sig);
  return { txHash: tx.hash, sig, noteHash, round, bindingHash };
}
export async function finalizeChallengeOnChain(uuid, topicId)  { return sendTx('finalizeChallenge', [uuidToBytes32(uuid), topicId]); }
export async function markLapsedOnChain(uuid, topicId)         { return sendTx('markLapsed', [uuidToBytes32(uuid), topicId]); }
export async function boostQueuedOnChain(uuid, topicId)        { return sendTx('boostQueued', [uuidToBytes32(uuid), topicId]); }
export async function promoteOnChain(uuid, topicId)           { return sendTx('promote', [uuidToBytes32(uuid), topicId]); }

// ── Tx confirmation ─────────────────────────────────────────────────────────

export async function waitForTx(txHash, { pollMs = 2000, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await window.ethereum.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (receipt) {
      if (receipt.status === '0x0') throw new Error('Transaction reverted on-chain');
      return receipt;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('Transaction confirmation timed out');
}

