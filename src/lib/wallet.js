/**
 * Public wallet API surface. Ethers-free at the module level so importing
 * this file does NOT block first paint on the ethers v6 bundle (~155 KB
 * gzip). Heavy work lives in wallet-impl.js and is dynamically imported on
 * first call — Vite emits it as a separate chunk that downloads in
 * parallel with the initial render.
 *
 * `prefetchWallet()` is exposed so a page that knows it will need the chain
 * client soon (e.g. /peer-review/) can warm the chunk in a useEffect after
 * mount without making any of the user-facing calls wait for the round-trip.
 */
import {
  CONSENSUS_ADDR, CONSENSUS_CHAIN_ID, CONSENSUS_ABI,
  MULTICALL3_ADDR,
  ATTESTATION_DOMAIN, ATTESTATION_TYPES, buildEIP712DomainType,
  signAttestation,
  BEHAVIOUR_CONSENSUS_ADDR, BEHAVIOUR_CONSENSUS_ABI,
  BEHAVIOUR_ATTESTATION_DOMAIN, BEHAVIOUR_ATTESTATION_TYPES,
  buildBehaviourEIP712DomainType, signBehaviourAttestation,
} from './wallet-constants';

// Re-export the ethers-free surface verbatim.
export {
  CONSENSUS_ADDR, CONSENSUS_CHAIN_ID, CONSENSUS_ABI,
  MULTICALL3_ADDR,
  ATTESTATION_DOMAIN, ATTESTATION_TYPES, buildEIP712DomainType,
  signAttestation,
  BEHAVIOUR_CONSENSUS_ADDR, BEHAVIOUR_CONSENSUS_ABI,
  BEHAVIOUR_ATTESTATION_DOMAIN, BEHAVIOUR_ATTESTATION_TYPES,
  buildBehaviourEIP712DomainType, signBehaviourAttestation,
};

// ── Lazy impl loader ────────────────────────────────────────────────────────

let _implPromise = null;
function impl() {
  if (!_implPromise) _implPromise = import('./wallet-impl');
  return _implPromise;
}

/// Trigger the wallet-impl chunk download without invoking any function. Safe
/// to call from a useEffect; resolves once the bundle is parsed.
export function prefetchWallet() { return impl(); }

// ── Re-exports — lazy wrappers ──────────────────────────────────────────────
// Each thin wrapper preserves the original (uuid, ...) → Promise signature so
// no call site needs to change.

export const uuidToBytes32                  = (...a) => impl().then(m => m.uuidToBytes32(...a));
export const bytes32ToUuid                  = (...a) => impl().then(m => m.bytes32ToUuid(...a));
export const computeContentHash             = (...a) => impl().then(m => m.computeContentHash(...a));

export const connectWallet                  = (...a) => impl().then(m => m.connectWallet(...a));
export const switchToTargetChain            = (...a) => impl().then(m => m.switchToTargetChain(...a));

export const getActivePeerCount             = (...a) => impl().then(m => m.getActivePeerCount(...a));
export const isPeerActive                   = (...a) => impl().then(m => m.isPeerActive(...a));
export const isGenesisPeer                  = (...a) => impl().then(m => m.isGenesisPeer(...a));
export const getPeerHandle                  = (...a) => impl().then(m => m.getPeerHandle(...a));
export const getNomineeThreshold            = (...a) => impl().then(m => m.getNomineeThreshold(...a));
export const getRevokeThreshold             = (...a) => impl().then(m => m.getRevokeThreshold(...a));
export const isNomineeAddress               = (...a) => impl().then(m => m.isNomineeAddress(...a));
export const getNomineeEndorsements         = (...a) => impl().then(m => m.getNomineeEndorsements(...a));
export const hasEndorsedNominee             = (...a) => impl().then(m => m.hasEndorsedNominee(...a));
export const getNomineeHandle               = (...a) => impl().then(m => m.getNomineeHandle(...a));
export const isRevocationActive             = (...a) => impl().then(m => m.isRevocationActive(...a));
export const getRevokeVoteCount             = (...a) => impl().then(m => m.getRevokeVoteCount(...a));
export const hasVotedForRevoke              = (...a) => impl().then(m => m.hasVotedForRevoke(...a));
export const getChallengeCooldownRemaining  = (...a) => impl().then(m => m.getChallengeCooldownRemaining(...a));
export const isNominationsOpen              = (...a) => impl().then(m => m.isNominationsOpen(...a));
export const getSeedPhaseK                  = (...a) => impl().then(m => m.getSeedPhaseK(...a));

export const hasVotedOnChain                = (...a) => impl().then(m => m.hasVotedOnChain(...a));
export const hasVotedManyOnChain            = (...a) => impl().then(m => m.hasVotedManyOnChain(...a));
export const hasVotedForRevokeMany          = (...a) => impl().then(m => m.hasVotedForRevokeMany(...a));

export const getActivePeersAggregated       = (...a) => impl().then(m => m.getActivePeersAggregated(...a));
export const getNomineesAggregated          = (...a) => impl().then(m => m.getNomineesAggregated(...a));
export const getPeerList                    = (...a) => impl().then(m => m.getPeerList(...a));
export const getNomineeList                 = (...a) => impl().then(m => m.getNomineeList(...a));

export const nominatePeer                   = (...a) => impl().then(m => m.nominatePeer(...a));
export const endorseNominee                 = (...a) => impl().then(m => m.endorseNominee(...a));
export const motionRevoke                   = (...a) => impl().then(m => m.motionRevoke(...a));
export const voteRevoke                     = (...a) => impl().then(m => m.voteRevoke(...a));
export const submitEvidenceOnChain          = (...a) => impl().then(m => m.submitEvidenceOnChain(...a));
export const castReviewVoteOnChain          = (...a) => impl().then(m => m.castReviewVoteOnChain(...a));
export const castReviewVoteBatchOnChain     = (...a) => impl().then(m => m.castReviewVoteBatchOnChain(...a));
export const openChallengeOnChain           = (...a) => impl().then(m => m.openChallengeOnChain(...a));
export const castChallengeVoteOnChain       = (...a) => impl().then(m => m.castChallengeVoteOnChain(...a));
export const finalizeChallengeOnChain       = (...a) => impl().then(m => m.finalizeChallengeOnChain(...a));
export const markLapsedOnChain              = (...a) => impl().then(m => m.markLapsedOnChain(...a));

export const waitForTx                      = (...a) => impl().then(m => m.waitForTx(...a));

// ── BehaviourConsensus lazy wrappers ────────────────────────────────────────

export const computeTripleHash                       = (...a) => impl().then(m => m.computeTripleHash(...a));
export const getBehaviourCanonizeThreshold           = (...a) => impl().then(m => m.getBehaviourCanonizeThreshold(...a));
export const getBehaviourExpelThreshold              = (...a) => impl().then(m => m.getBehaviourExpelThreshold(...a));
export const getBehaviourDeprecateThreshold          = (...a) => impl().then(m => m.getBehaviourDeprecateThreshold(...a));
export const getBehaviourChallengeCooldownRemaining  = (...a) => impl().then(m => m.getBehaviourChallengeCooldownRemaining(...a));
export const hasVotedOnBehaviour                     = (...a) => impl().then(m => m.hasVotedOnBehaviour(...a));

export const submitBehaviourOnChain                  = (...a) => impl().then(m => m.submitBehaviourOnChain(...a));
export const castBehaviourReviewVoteOnChain          = (...a) => impl().then(m => m.castBehaviourReviewVoteOnChain(...a));
export const castBehaviourReviewVoteBatchOnChain     = (...a) => impl().then(m => m.castBehaviourReviewVoteBatchOnChain(...a));
export const openBehaviourChallengeOnChain           = (...a) => impl().then(m => m.openBehaviourChallengeOnChain(...a));
export const castBehaviourChallengeVoteOnChain       = (...a) => impl().then(m => m.castBehaviourChallengeVoteOnChain(...a));
export const finalizeBehaviourChallengeOnChain       = (...a) => impl().then(m => m.finalizeBehaviourChallengeOnChain(...a));
export const markBehaviourLapsedOnChain              = (...a) => impl().then(m => m.markBehaviourLapsedOnChain(...a));
