/**
 * Ethers-free shared constants. Imported by both wallet.js (sync, light)
 * and wallet-impl.js (lazy-loaded, heavy). Keeping these in their own
 * module means the initial page bundle picks them up without dragging in
 * ethers — wallet.js stays under 10 KB until the user does something that
 * actually needs the chain client.
 */

// Accept either hex ('0x61') or decimal ('97') for VITE_CONSENSUS_CHAIN_ID
// and derive both forms internally. EIP-712 needs a numeric chainId; the
// wallet switch RPC needs the hex form. Without this normalization,
// parseInt('97', 16) === 151 silently corrupts the EIP-712 domain.
function parseChainIdEnv(raw, fallbackNum) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return fallbackNum;
  const n = s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallbackNum;
}

export const CONSENSUS_CHAIN_ID = parseChainIdEnv(import.meta.env.VITE_CONSENSUS_CHAIN_ID, 97);
export const CONSENSUS_ADDR     = import.meta.env.VITE_CONSENSUS_ADDR || null;
// Read-only Lens sidecar holding the peer/nominee/proposal aggregation views
// moved off the core for EIP-170 headroom. Deployed alongside the core.
export const CONSENSUS_LENS_ADDR = import.meta.env.VITE_CONSENSUS_LENS_ADDR || null;
// PeerGovernance sidecar holding the nominee + revocation flows (and their
// state/views) moved off the core for EIP-170 headroom. The core only exposes
// gAddPeer/gRemovePeer to it; all nominate/endorse/revoke calls target this.
export const CONSENSUS_GOVERNANCE_ADDR = import.meta.env.VITE_CONSENSUS_GOVERNANCE_ADDR || null;

export const CONSENSUS_ABI = [
  // Views — peer registry
  "function activePeerCount() view returns (uint256)",
  "function isActivePeer(address) view returns (bool)",
  "function isPeer(address) view returns (bool)",
  "function peerHandle(address) view returns (string)",
  "function peerList() view returns (address[])",
  "function lastActive(address) view returns (uint48)",
  // Views — binding vote eligibility (nominee/revocation views live on governance)
  "function hasVoted(bytes32,uint8,address) view returns (bool)",  // keyed by bindingId
  // Views — evidence + bindings
  "function bindingId(bytes32 id, bytes32 topicId) pure returns (bytes32)",
  "function getEvidence(bytes32 id) view returns (tuple(bool exists, uint8 tier, address submitter, uint48 submittedAt, uint32 bindingCount, bytes32 contentHash))",
  "function getBinding(bytes32 id, bytes32 topicId) view returns (tuple(uint8 state, bytes32 evidenceId, bytes32 topicId, uint32 approveCount, uint32 rejectCount, uint32 challengeVotes, uint32 defenseVotes, uint48 submittedAt, uint48 canonAt, uint48 challengedAt, uint32 challengeRound, uint32 reviewRound, uint32 peerSnapshot))",
  "function evidenceReserved(bytes32) view returns (bool)",
  "function pendingProposals(address) view returns (uint32)",
  "function canonizeThreshold(uint8 tier) view returns (uint256)",
  "function expelThreshold() view returns (uint256)",
  "function deprecateThreshold(uint8 tier) view returns (uint256)",
  // Views — submission queue
  "function reviewCapacity() view returns (uint256)",
  "function activeReviewCount() view returns (uint256)",
  // Views — seed phase + owner (nominationsOpen lives on governance)
  "function seedPhaseK() view returns (uint256)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function forceRenounceActive() view returns (bool)",
  "function forceRenounceVotes() view returns (uint32)",
  // Views — taxonomy
  "function taxonomyThreshold() view returns (uint256)",
  "function retireThreshold() view returns (uint256)",
  "function bundleThreshold(uint8 tier) view returns (uint256)",
  "function getTaxonomyNode(bytes32) view returns (tuple(uint8 kind, uint8 state, bytes32 parent, bytes32 metaHash, address proposedBy, uint48 proposedAt, uint32 endorsements))",
  "function hasEndorsedNode(bytes32, address) view returns (bool)",
  "function getPillars() view returns (bytes32[] ids, bytes32[] metaHashes)",
  "function getTopics(bytes32 pillar) view returns (bytes32[] ids, bytes32[] metaHashes)",
  "function proposedNodeIds() view returns (bytes32[])",
  // Views — taxonomy retirement
  "function retireActive(bytes32) view returns (bool)",
  "function retireVotes(bytes32) view returns (uint32)",
  "function retireMotionAt(bytes32) view returns (uint48)",
  "function hasVotedRetire(bytes32 id, address voter) view returns (bool)",
  // Writes — peer registry (owner seed only; nominee/revocation live on governance)
  "function addPeer(address peer, string handle)",
  // Writes — peer liveness / garbage collection
  "function heartbeat()",
  "function pruneInactivePeer(address peer)",
  // Writes — force-renounce (peer supermajority evicts a captured/paused owner)
  "function motionForceRenounce()",
  "function voteForceRenounce()",
  // Writes — taxonomy (every node is bootstrapped with a founding evidence)
  "function proposePillar(bytes32 id, bytes32 metaHash, bytes32 topicId, bytes32 topicMetaHash, bytes32 evidenceId, uint8 tier, bytes32 contentHash)",
  "function proposeTopic(bytes32 id, bytes32 parentPillar, bytes32 metaHash, bytes32 evidenceId, uint8 tier, bytes32 contentHash)",
  "function endorseNode(bytes32 id)",
  "function lapseProposal(bytes32 id)",
  // Writes — taxonomy retirement
  "function motionRetireNode(bytes32 id)",
  "function voteRetireNode(bytes32 id)",
  "function cancelStaleRetire(bytes32 id)",
  // Writes — evidence + (evidence × topic) bindings
  "function submitEvidence(bytes32 id, uint8 tier, bytes32 topicId, bytes32 contentHash)",
  "function fileBinding(bytes32 id, bytes32 topicId)",
  "function castReviewVote(bytes32 id, bytes32 topicId, bool approve, bytes32 noteHash, bytes sig)",
  "function castReviewVoteBatch(bytes32[] ids, bytes32[] topicIds, bool[] approves, bytes32[] noteHashes, bytes[] sigs)",
  "function openChallenge(bytes32 id, bytes32 topicId, bytes32 noteHash, bytes sig)",
  "function castChallengeVote(bytes32 id, bytes32 topicId, bool supportChallenge, bytes32 noteHash, bytes sig)",
  "function markLapsed(bytes32 id, bytes32 topicId)",
  "function finalizeChallenge(bytes32 id, bytes32 topicId)",
  // Writes — submission queue (boost is open to anyone; promote is permissionless)
  "function boostQueued(bytes32 id, bytes32 topicId)",
  "function promote(bytes32 id, bytes32 topicId)",
];

// Read-only aggregation views served by the Lens sidecar (moved off the core
// for EIP-170 headroom). getActivePeers now also returns each peer's liveness
// clock (lastActives) used by the garbage-collection UI.
export const CONSENSUS_LENS_ABI = [
  "function isGenesisPeer(address) view returns (bool)",
  "function challengeCooldownRemaining(address) view returns (uint256)",
  "function boostCooldownRemaining(address) view returns (uint256)",
  "function getActivePeers() view returns (address[] addrs, string[] handles, bool[] revActive, uint32[] revVotes, uint48[] lastActives)",
  "function getNominees() view returns (address[] addrs, string[] handles, uint32[] endorsements)",
  "function getProposedNodes() view returns (bytes32[] ids, uint8[] kinds, bytes32[] parents, bytes32[] metaHashes, address[] proposers, uint32[] endorsements)",
];

// PeerGovernance sidecar ABI — the nominee + revocation flows (+ their views)
// moved off the core. nominationsOpen/nomineeThreshold/revokeThreshold read the
// core's activePeerCount/seedPhaseK/owner internally.
export const GOVERNANCE_ABI = [
  // Views — nominees
  "function nomineeThreshold() view returns (uint256)",
  "function revokeThreshold() view returns (uint256)",
  "function nominationsOpen() view returns (bool)",
  "function isNominated(address) view returns (bool)",
  "function nomineeHandle(address) view returns (string)",
  "function nomineeEndorsements(address) view returns (uint32)",
  "function hasEndorsed(address,address) view returns (bool)",
  "function nomineeList() view returns (address[])",
  // Views — revocation
  "function revocationActive(address) view returns (bool)",
  "function revokeVoteCount(address) view returns (uint32)",
  "function revokeRound(address) view returns (uint32)",
  "function hasVotedRevoke(address,address) view returns (bool)",
  // Writes
  "function nominatePeer(address nominee, string handle)",
  "function endorseNominee(address)",
  "function lapseNominee(address nominee)",
  "function motionRevoke(address)",
  "function voteRevoke(address)",
  "function cancelStaleRevocation(address peer)",
];

// Multicall3 — canonical deploy at the same address on every EVM chain
// (including BSC mainnet + testnet).
export const MULTICALL3_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])',
];

// ── EIP-712 attestation domain + types ──────────────────────────────────────
// Domain must match the verify-attestation edge function exactly.
// verifyingContract is omitted when CONSENSUS_ADDR is unset so dev-mode sigs
// round-trip.
export const ATTESTATION_DOMAIN = {
  name:    'EvidenceConsensus',
  version: '1',
  chainId: CONSENSUS_CHAIN_ID,
  ...(CONSENSUS_ADDR ? { verifyingContract: CONSENSUS_ADDR } : {}),
};

export function buildEIP712DomainType() {
  const fields = [
    { name: 'name',    type: 'string'  },
    { name: 'version', type: 'string'  },
    { name: 'chainId', type: 'uint256' },
  ];
  if (CONSENSUS_ADDR) fields.push({ name: 'verifyingContract', type: 'address' });
  return fields;
}

// A vote attests to a specific (evidence × topic) binding, so the signed
// message carries `topicId` alongside the evidence id. An empty topicId is
// tolerated for legacy/evidence-wide actions. Must match the verify-attestation
// edge function exactly.
export const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'evidenceId', type: 'string'  },
    { name: 'topicId',    type: 'string'  },
    { name: 'peerAddr',   type: 'address' },
    { name: 'phase',      type: 'string'  },
    { name: 'verdict',    type: 'string'  },
    { name: 'note',       type: 'string'  },
  ],
};

// On-chain vote authorization. Review / challenge votes are recovered ON-CHAIN
// from this signature by EvidenceConsensus, so the fields + order MUST match the
// contract's `keccak256("Vote(bytes32 bindingId,uint8 phase,bool support,uint32 round,bytes32 noteHash)")`
// byte-for-byte. phase: 0 = review, 1 = challenge. The verify-attestation edge
// function recovers the same typed data. Taxonomy endorse/reject still use the
// Attestation type above (those are off-chain governance, not by-sig votes).
export const VOTE_TYPES = {
  Vote: [
    { name: 'bindingId', type: 'bytes32' },
    { name: 'phase',     type: 'uint8'   },
    { name: 'support',   type: 'bool'    },
    { name: 'round',     type: 'uint32'  },
    { name: 'noteHash',  type: 'bytes32' },
  ],
};

// Pure MetaMask RPC — no ethers required. Kept in the light constants module
// so callers (e.g. SignModal flow) can sign without triggering the lazy load.
export async function signAttestation(payload, addr) {
  if (!window.ethereum) throw new Error('MetaMask not available');
  const message = {
    evidenceId: String(payload.evidenceId ?? ''),
    topicId:    String(payload.topicId ?? ''),
    peerAddr:   addr,
    phase:      String(payload.phase   ?? ''),
    verdict:    String(payload.verdict ?? ''),
    note:       String(payload.note    ?? ''),
  };
  const typedData = {
    types:       { EIP712Domain: buildEIP712DomainType(), ...ATTESTATION_TYPES },
    domain:      ATTESTATION_DOMAIN,
    primaryType: 'Attestation',
    message,
  };
  return window.ethereum.request({
    method: 'eth_signTypedData_v4',
    params: [addr, JSON.stringify(typedData)],
  });
}
