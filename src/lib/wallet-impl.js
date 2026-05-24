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
import { AbiCoder, BrowserProvider, Contract, Interface, JsonRpcProvider, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import {
  CONSENSUS_ADDR, CONSENSUS_ABI, CONSENSUS_CHAIN_ID,
  CONSENSUS_LENS_ADDR, CONSENSUS_LENS_ABI,
  MULTICALL3_ADDR, MULTICALL3_ABI,
  ATTESTATION_DOMAIN, ATTESTATION_TYPES,
} from './wallet-constants';

const TARGET_CHAIN_ID_HEX = '0x' + CONSENSUS_CHAIN_ID.toString(16);

export const IFACE             = new Interface(CONSENSUS_ABI);
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

export function computeContentHash({ title, source, year, excerpt, link, tier }) {
  const canon = JSON.stringify({
    title:   String(title ?? '').trim(),
    source:  String(source ?? '').trim(),
    year:    String(year ?? '').trim(),
    excerpt: String(excerpt ?? '').trim(),
    link:    String(link ?? '').trim(),
    tier:    Number(tier),
  });
  return keccak256(toUtf8Bytes(canon));
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

export function computeMetaHash({ kind, slug, parent, title, blurb, tag }) {
  const canon = JSON.stringify({
    kind:   String(kind),
    slug:   String(slug ?? '').trim(),
    parent: String(parent ?? '').trim(),
    title:  String(title ?? '').trim(),
    blurb:  String(blurb ?? '').trim(),
    tag:    String(tag ?? '').trim(),
  });
  return keccak256(toUtf8Bytes(canon));
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
export const getNomineeThreshold      = safe(async ()           => Number(await readContract().nomineeThreshold()), 1);
export const getRevokeThreshold       = safe(async ()           => Number(await readContract().revokeThreshold()), 1);
export const isNomineeAddress         = safe(async (addr)       => await readContract().isNominated(addr), false);
export const getNomineeEndorsements   = safe(async (addr)       => Number(await readContract().nomineeEndorsements(addr)), 0);
export const hasEndorsedNominee       = safe(async (nom, from)  => await readContract().hasEndorsed(nom, from), false);
export const getNomineeHandle         = safe(async (addr)       => await readContract().nomineeHandle(addr), '');
export const isRevocationActive       = safe(async (addr)       => await readContract().revocationActive(addr), false);
export const getRevokeVoteCount       = safe(async (addr)       => Number(await readContract().revokeVoteCount(addr)), 0);
export const hasVotedForRevoke        = safe(async (t, v)       => await readContract().hasVotedRevoke(t, v), false);
export const getChallengeCooldownRemaining = safe(async (addr)  => Number(await lensContract().challengeCooldownRemaining(addr)), 0);
export const getBoostCooldownRemaining     = safe(async (addr)  => Number(await lensContract().boostCooldownRemaining(addr)), 0);
export const isNominationsOpen        = safe(async ()           => await readContract().nominationsOpen(), false);
export const getSeedPhaseK            = safe(async ()           => Number(await readContract().seedPhaseK()), 0);

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
  if (!CONSENSUS_ADDR || !peerAddrs.length) return new Map();
  const calls = peerAddrs.map(p => ({
    target:   CONSENSUS_ADDR,
    callData: IFACE.encodeFunctionData('hasVotedRevoke', [p, voterAddr]),
  }));
  try {
    const results = await multicallAggregate3(calls);
    const out = new Map();
    results.forEach((r, i) => {
      let v = false;
      if (r.success) {
        try { [v] = IFACE.decodeFunctionResult('hasVotedRevoke', r.returnData); } catch { v = false; }
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
    const list = await readContract().nomineeList();
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
    const [ids, kinds, parents, metaHashes, proposers, endorsements] = await lensContract().getProposedNodes();
    return ids.map((id, i) => ({
      id:           id.toLowerCase(),
      kind:         Number(kinds[i]),               // 0 = pillar, 1 = topic
      parent:       (parents[i] ?? '').toLowerCase(),
      metaHash:     (metaHashes[i] ?? '').toLowerCase(),
      proposer:     (proposers[i] ?? '').toLowerCase(),
      endorsements: Number(endorsements[i] ?? 0),
    }));
  } catch { return []; }
}

// ── Writes ──────────────────────────────────────────────────────────────────

async function sendTx(fnName, args) {
  const c  = await writeContract();
  const tx = await c[fnName](...args);
  return tx.hash;
}

export async function nominatePeer(nominee, handle)            { return sendTx('nominatePeer', [nominee, handle]); }
export async function endorseNominee(nominee)                  { return sendTx('endorseNominee', [nominee]); }
export async function lapseNominee(nominee)                    { return sendTx('lapseNominee', [nominee]); }
export async function motionRevoke(peer)                       { return sendTx('motionRevoke', [peer]); }
export async function voteRevoke(peer)                         { return sendTx('voteRevoke', [peer]); }
export async function heartbeatOnChain()                       { return sendTx('heartbeat', []); }
export async function pruneInactivePeerOnChain(peer)           { return sendTx('pruneInactivePeer', [peer]); }
// Peer supermajority (2/3) eviction of a captured/paused owner.
export async function motionForceRenounce()                    { return sendTx('motionForceRenounce', []); }
export async function voteForceRenounce()                      { return sendTx('voteForceRenounce', []); }

// Taxonomy governance. node ids are bytes32 = slugToBytes32(slug); metaHash from
// computeMetaHash(). Every node is bootstrapped with a founding evidence: a
// pillar bundles its first topic + evidence, a topic bundles its first evidence.
// `evidenceUuid` is the off-chain evidence UUID (encoded to bytes32 here);
// `contentHash` is computeContentHash() of that evidence.
export async function proposePillarOnChain(id, metaHash, topicId, topicMetaHash, evidenceUuid, tier, contentHash) {
  return sendTx('proposePillar', [id, metaHash, topicId, topicMetaHash, uuidToBytes32(evidenceUuid), tier, contentHash]);
}
export async function proposeTopicOnChain(id, parentPillar, metaHash, evidenceUuid, tier, contentHash) {
  return sendTx('proposeTopic', [id, parentPillar, metaHash, uuidToBytes32(evidenceUuid), tier, contentHash]);
}
export async function endorseNodeOnChain(id)                        { return sendTx('endorseNode', [id]); }

// Taxonomy retirement (ratified-node governance). `id` is the bytes32 node id.
export async function motionRetireNodeOnChain(id)                   { return sendTx('motionRetireNode', [id]); }
export async function voteRetireNodeOnChain(id)                     { return sendTx('voteRetireNode', [id]); }
export async function cancelStaleRetireOnChain(id)                  { return sendTx('cancelStaleRetire', [id]); }

export async function submitEvidenceOnChain(uuid, tier, topicId, ch) { return sendTx('submitEvidence', [uuidToBytes32(uuid), tier, topicId, ch]); }
export async function fileBindingOnChain(uuid, topicId)        { return sendTx('fileBinding', [uuidToBytes32(uuid), topicId]); }
export async function castReviewVoteOnChain(uuid, topicId, approve) { return sendTx('castReviewVote', [uuidToBytes32(uuid), topicId, approve]); }
export async function castReviewVoteBatchOnChain(uuids, topicIds, aprs) {
  if (![uuids, topicIds, aprs].every(Array.isArray) || uuids.length !== aprs.length || uuids.length !== topicIds.length) {
    throw new Error('Batch arrays must be same length');
  }
  return sendTx('castReviewVoteBatch', [uuids.map(uuidToBytes32), topicIds, aprs]);
}
export async function openChallengeOnChain(uuid, topicId)      { return sendTx('openChallenge', [uuidToBytes32(uuid), topicId]); }
export async function castChallengeVoteOnChain(uuid, topicId, support) { return sendTx('castChallengeVote', [uuidToBytes32(uuid), topicId, support]); }
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

