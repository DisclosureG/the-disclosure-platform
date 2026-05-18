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

export const CONSENSUS_ABI = [
  // Views — peer registry
  "function activePeerCount() view returns (uint256)",
  "function isActivePeer(address) view returns (bool)",
  "function isPeer(address) view returns (bool)",
  "function isGenesisPeer(address) view returns (bool)",
  "function peerHandle(address) view returns (string)",
  "function peerList() view returns (address[])",
  "function getActivePeers() view returns (address[] addrs, string[] handles, bool[] revActive, uint32[] revVotes)",
  // Views — nominees
  "function nomineeThreshold() view returns (uint256)",
  "function revokeThreshold() view returns (uint256)",
  "function isNominated(address) view returns (bool)",
  "function nomineeHandle(address) view returns (string)",
  "function nomineeEndorsements(address) view returns (uint32)",
  "function hasEndorsed(address,address) view returns (bool)",
  "function nomineeList() view returns (address[])",
  "function getNominees() view returns (address[] addrs, string[] handles, uint32[] endorsements)",
  // Views — revocation, voting, cooldown
  "function revocationActive(address) view returns (bool)",
  "function revokeVoteCount(address) view returns (uint32)",
  "function hasVotedRevoke(address,address) view returns (bool)",
  "function hasVoted(bytes32,uint8,address) view returns (bool)",
  "function challengeCooldownRemaining(address) view returns (uint256)",
  // Views — seed phase
  "function seedPhaseK() view returns (uint256)",
  "function nominationsOpen() view returns (bool)",
  // Writes — peer registry
  "function nominatePeer(address nominee, string handle)",
  "function endorseNominee(address)",
  "function motionRevoke(address)",
  "function voteRevoke(address)",
  // Writes — evidence
  "function submitEvidence(bytes32 id, uint8 tier, bytes32 contentHash)",
  "function castReviewVote(bytes32 id, bool approve)",
  "function castReviewVoteBatch(bytes32[] ids, bool[] approves)",
  "function openChallenge(bytes32 id)",
  "function castChallengeVote(bytes32 id, bool supportChallenge)",
  "function markLapsed(bytes32 id)",
  "function finalizeChallenge(bytes32 id)",
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

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'evidenceId', type: 'string'  },
    { name: 'peerAddr',   type: 'address' },
    { name: 'phase',      type: 'string'  },
    { name: 'verdict',    type: 'string'  },
    { name: 'note',       type: 'string'  },
  ],
};

// Pure MetaMask RPC — no ethers required. Kept in the light constants module
// so callers (e.g. SignModal flow) can sign without triggering the lazy load.
export async function signAttestation(payload, addr) {
  if (!window.ethereum) throw new Error('MetaMask not available');
  const message = {
    evidenceId: String(payload.evidenceId ?? ''),
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

// ── BehaviourConsensus (alignment archive) ──────────────────────────────────
// Sibling contract that reads the peer registry from EvidenceConsensus.
// Chain id is shared (same network); deploy block / address differ.

export const BEHAVIOUR_CONSENSUS_ADDR = import.meta.env.VITE_BEHAVIOUR_CONSENSUS_ADDR || null;

export const BEHAVIOUR_CONSENSUS_ABI = [
  // Views
  "function peers() view returns (address)",
  "function records(bytes32 id) view returns (uint8 state, uint8 tier, uint8 domain, uint32 approveCount, uint32 rejectCount, uint32 challengeVotes, uint32 defenseVotes, uint48 submittedAt, uint48 canonAt, uint48 challengedAt, bytes32 modelHash, bytes32 inputHash, bytes32 outputHash, bytes32 challengerFirst)",
  "function hasVoted(bytes32,uint8,address) view returns (bool)",
  "function challengeCooldownRemaining(address) view returns (uint256)",
  "function canonizeThreshold(uint8 tier) view returns (uint256)",
  "function expelThreshold() view returns (uint256)",
  "function deprecateThreshold(uint8 tier) view returns (uint256)",
  "function getThresholds(bytes32 id) view returns (uint256, uint256, uint256)",
  "function tripleHash(bytes32 modelHash, bytes32 inputHash, bytes32 outputHash) pure returns (bytes32)",
  "function paused() view returns (bool)",
  // Writes
  "function submitBehaviour(bytes32 id, uint8 tier, uint8 domain, bytes32 modelHash, bytes32 inputHash, bytes32 outputHash)",
  "function castReviewVote(bytes32 id, bool approve)",
  "function castReviewVoteBatch(bytes32[] ids, bool[] approves)",
  "function openChallenge(bytes32 id, string grounds)",
  "function castChallengeVote(bytes32 id, bool supportChallenge)",
  "function markLapsed(bytes32 id)",
  "function finalizeChallenge(bytes32 id)",
];

// Same chainId as evidence — both contracts live on the same network.
export const BEHAVIOUR_ATTESTATION_DOMAIN = {
  name:    'BehaviourConsensus',
  version: '1',
  chainId: CONSENSUS_CHAIN_ID,
  ...(BEHAVIOUR_CONSENSUS_ADDR ? { verifyingContract: BEHAVIOUR_CONSENSUS_ADDR } : {}),
};

export function buildBehaviourEIP712DomainType() {
  const fields = [
    { name: 'name',    type: 'string'  },
    { name: 'version', type: 'string'  },
    { name: 'chainId', type: 'uint256' },
  ];
  if (BEHAVIOUR_CONSENSUS_ADDR) fields.push({ name: 'verifyingContract', type: 'address' });
  return fields;
}

export const BEHAVIOUR_ATTESTATION_TYPES = {
  Attestation: [
    { name: 'behaviourId', type: 'string'  },
    { name: 'peerAddr',    type: 'address' },
    { name: 'phase',       type: 'string'  },
    { name: 'verdict',     type: 'string'  },
    { name: 'note',        type: 'string'  },
  ],
};

export async function signBehaviourAttestation(payload, addr) {
  if (!window.ethereum) throw new Error('MetaMask not available');
  const message = {
    behaviourId: String(payload.behaviourId ?? ''),
    peerAddr:    addr,
    phase:       String(payload.phase   ?? ''),
    verdict:     String(payload.verdict ?? ''),
    note:        String(payload.note    ?? ''),
  };
  const typedData = {
    types:       { EIP712Domain: buildBehaviourEIP712DomainType(), ...BEHAVIOUR_ATTESTATION_TYPES },
    domain:      BEHAVIOUR_ATTESTATION_DOMAIN,
    primaryType: 'Attestation',
    message,
  };
  return window.ethereum.request({
    method: 'eth_signTypedData_v4',
    params: [addr, JSON.stringify(typedData)],
  });
}
