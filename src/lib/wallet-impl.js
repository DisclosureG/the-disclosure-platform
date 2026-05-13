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
import { BrowserProvider, Contract, Interface, JsonRpcProvider, keccak256, toUtf8Bytes } from 'ethers';
import {
  CONSENSUS_ADDR, CONSENSUS_ABI, CONSENSUS_CHAIN_ID,
  MULTICALL3_ADDR, MULTICALL3_ABI,
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

const READ_RPC = import.meta.env.VITE_CONSENSUS_READ_RPC || null;
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

export function computeContentHash({ title, source, year, excerpt, link, tier, pillar_id }) {
  const canon = JSON.stringify({
    title:     String(title ?? '').trim(),
    source:    String(source ?? '').trim(),
    year:      String(year ?? '').trim(),
    excerpt:   String(excerpt ?? '').trim(),
    link:      String(link ?? '').trim(),
    tier:      Number(tier),
    pillar_id: String(pillar_id ?? '').trim(),
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
export const isGenesisPeer            = safe(async (addr)       => await readContract().isGenesisPeer(addr), false);
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
export const getChallengeCooldownRemaining = safe(async (addr)  => Number(await readContract().challengeCooldownRemaining(addr)), 0);
export const isNominationsOpen        = safe(async ()           => await readContract().nominationsOpen(), false);
export const getSeedPhaseK            = safe(async ()           => Number(await readContract().seedPhaseK()), 0);

export async function hasVotedOnChain(uuid, phase, addr) {
  try { return await readContract().hasVoted(uuidToBytes32(uuid), phase, addr); }
  catch { return false; }
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

export async function hasVotedManyOnChain(uuids, phase, addr) {
  if (!CONSENSUS_ADDR || !uuids.length) return new Map();
  const calls = uuids.map(uuid => ({
    target:   CONSENSUS_ADDR,
    callData: IFACE.encodeFunctionData('hasVoted', [uuidToBytes32(uuid), phase, addr]),
  }));
  try {
    const results = await multicallAggregate3(calls);
    const out = new Map();
    results.forEach((r, i) => {
      let v = false;
      if (r.success) {
        try { [v] = IFACE.decodeFunctionResult('hasVoted', r.returnData); } catch { v = false; }
      }
      out.set(uuids[i], !!v);
    });
    return out;
  } catch {
    return new Map(uuids.map(u => [u, false]));
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

// Aggregated peer / nominee views — single eth_call each.
export async function getActivePeersAggregated() {
  try {
    const [addrs, handles, revActive, revVotes] = await readContract().getActivePeers();
    return addrs.map((a, i) => ({
      addr:      a.toLowerCase(),
      handle:    handles[i] ?? '',
      revActive: revActive[i] ?? false,
      revVotes:  Number(revVotes[i] ?? 0),
    }));
  } catch { return []; }
}

export async function getNomineesAggregated() {
  try {
    const [addrs, handles, endorsements] = await readContract().getNominees();
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

// ── Writes ──────────────────────────────────────────────────────────────────

async function sendTx(fnName, args) {
  const c  = await writeContract();
  const tx = await c[fnName](...args);
  return tx.hash;
}

export async function nominatePeer(nominee, handle)            { return sendTx('nominatePeer', [nominee, handle]); }
export async function endorseNominee(nominee)                  { return sendTx('endorseNominee', [nominee]); }
export async function motionRevoke(peer)                       { return sendTx('motionRevoke', [peer]); }
export async function voteRevoke(peer)                         { return sendTx('voteRevoke', [peer]); }
export async function submitEvidenceOnChain(uuid, tier, ch)    { return sendTx('submitEvidence', [uuidToBytes32(uuid), tier, ch]); }
export async function castReviewVoteOnChain(uuid, approve)     { return sendTx('castReviewVote', [uuidToBytes32(uuid), approve]); }
export async function castReviewVoteBatchOnChain(uuids, aprs) {
  if (!Array.isArray(uuids) || !Array.isArray(aprs) || uuids.length !== aprs.length) {
    throw new Error('Batch arrays must be same length');
  }
  return sendTx('castReviewVoteBatch', [uuids.map(uuidToBytes32), aprs]);
}
export async function openChallengeOnChain(uuid)               { return sendTx('openChallenge', [uuidToBytes32(uuid)]); }
export async function castChallengeVoteOnChain(uuid, support)  { return sendTx('castChallengeVote', [uuidToBytes32(uuid), support]); }
export async function finalizeChallengeOnChain(uuid)           { return sendTx('finalizeChallenge', [uuidToBytes32(uuid)]); }
export async function markLapsedOnChain(uuid)                  { return sendTx('markLapsed', [uuidToBytes32(uuid)]); }

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
