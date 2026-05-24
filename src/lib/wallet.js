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
} from './wallet-constants';

// Re-export the ethers-free surface verbatim.
export {
  CONSENSUS_ADDR, CONSENSUS_CHAIN_ID, CONSENSUS_ABI,
  MULTICALL3_ADDR,
  ATTESTATION_DOMAIN, ATTESTATION_TYPES, buildEIP712DomainType,
  signAttestation,
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
export const recoverAttestationSigner       = (...a) => impl().then(m => m.recoverAttestationSigner(...a));
export const bindingKey                     = (...a) => impl().then(m => m.bindingKey(...a));
export const slugToBytes32                  = (...a) => impl().then(m => m.slugToBytes32(...a));
export const computeMetaHash                = (...a) => impl().then(m => m.computeMetaHash(...a));

export const connectWallet                  = (...a) => impl().then(m => m.connectWallet(...a));
export const switchToTargetChain            = (...a) => impl().then(m => m.switchToTargetChain(...a));

export const getActivePeerCount             = (...a) => impl().then(m => m.getActivePeerCount(...a));
export const isPeerActive                   = (...a) => impl().then(m => m.isPeerActive(...a));
export const isGenesisPeer                  = (...a) => impl().then(m => m.isGenesisPeer(...a));
export const getLastActive                  = (...a) => impl().then(m => m.getLastActive(...a));
export const getReviewCapacity              = (...a) => impl().then(m => m.getReviewCapacity(...a));
export const getActiveReviewCount           = (...a) => impl().then(m => m.getActiveReviewCount(...a));
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
export const getBoostCooldownRemaining       = (...a) => impl().then(m => m.getBoostCooldownRemaining(...a));
export const isNominationsOpen              = (...a) => impl().then(m => m.isNominationsOpen(...a));
export const getSeedPhaseK                  = (...a) => impl().then(m => m.getSeedPhaseK(...a));

export const getTaxonomyThreshold           = (...a) => impl().then(m => m.getTaxonomyThreshold(...a));
export const getRetireThreshold             = (...a) => impl().then(m => m.getRetireThreshold(...a));
export const hasEndorsedNode                = (...a) => impl().then(m => m.hasEndorsedNode(...a));
export const isRetireActive                 = (...a) => impl().then(m => m.isRetireActive(...a));
export const getRetireVoteCount             = (...a) => impl().then(m => m.getRetireVoteCount(...a));
export const getRetireMotionAt              = (...a) => impl().then(m => m.getRetireMotionAt(...a));
export const hasVotedForRetire              = (...a) => impl().then(m => m.hasVotedForRetire(...a));
export const getPillarsAggregated           = (...a) => impl().then(m => m.getPillarsAggregated(...a));
export const getTopicsAggregated            = (...a) => impl().then(m => m.getTopicsAggregated(...a));
export const getProposedNodesAggregated     = (...a) => impl().then(m => m.getProposedNodesAggregated(...a));
export const proposePillarOnChain           = (...a) => impl().then(m => m.proposePillarOnChain(...a));
export const proposeTopicOnChain            = (...a) => impl().then(m => m.proposeTopicOnChain(...a));
export const endorseNodeOnChain             = (...a) => impl().then(m => m.endorseNodeOnChain(...a));
export const motionRetireNodeOnChain        = (...a) => impl().then(m => m.motionRetireNodeOnChain(...a));
export const voteRetireNodeOnChain          = (...a) => impl().then(m => m.voteRetireNodeOnChain(...a));
export const cancelStaleRetireOnChain       = (...a) => impl().then(m => m.cancelStaleRetireOnChain(...a));

export const hasVotedOnChain                = (...a) => impl().then(m => m.hasVotedOnChain(...a));
export const hasVotedManyOnChain            = (...a) => impl().then(m => m.hasVotedManyOnChain(...a));
export const hasVotedForRevokeMany          = (...a) => impl().then(m => m.hasVotedForRevokeMany(...a));
export const getBindingOnChain              = (...a) => impl().then(m => m.getBindingOnChain(...a));

export const getActivePeersAggregated       = (...a) => impl().then(m => m.getActivePeersAggregated(...a));
export const getNomineesAggregated          = (...a) => impl().then(m => m.getNomineesAggregated(...a));
export const getPeerList                    = (...a) => impl().then(m => m.getPeerList(...a));
export const getNomineeList                 = (...a) => impl().then(m => m.getNomineeList(...a));

export const nominatePeer                   = (...a) => impl().then(m => m.nominatePeer(...a));
export const endorseNominee                 = (...a) => impl().then(m => m.endorseNominee(...a));
export const lapseNominee                    = (...a) => impl().then(m => m.lapseNominee(...a));
export const motionRevoke                   = (...a) => impl().then(m => m.motionRevoke(...a));
export const voteRevoke                     = (...a) => impl().then(m => m.voteRevoke(...a));
export const heartbeatOnChain               = (...a) => impl().then(m => m.heartbeatOnChain(...a));
export const pruneInactivePeerOnChain       = (...a) => impl().then(m => m.pruneInactivePeerOnChain(...a));
export const motionForceRenounce            = (...a) => impl().then(m => m.motionForceRenounce(...a));
export const voteForceRenounce              = (...a) => impl().then(m => m.voteForceRenounce(...a));
export const submitEvidenceOnChain          = (...a) => impl().then(m => m.submitEvidenceOnChain(...a));
export const fileBindingOnChain             = (...a) => impl().then(m => m.fileBindingOnChain(...a));
export const castReviewVoteOnChain          = (...a) => impl().then(m => m.castReviewVoteOnChain(...a));
export const castReviewVoteBatchOnChain     = (...a) => impl().then(m => m.castReviewVoteBatchOnChain(...a));
export const openChallengeOnChain           = (...a) => impl().then(m => m.openChallengeOnChain(...a));
export const castChallengeVoteOnChain       = (...a) => impl().then(m => m.castChallengeVoteOnChain(...a));
export const finalizeChallengeOnChain       = (...a) => impl().then(m => m.finalizeChallengeOnChain(...a));
export const markLapsedOnChain              = (...a) => impl().then(m => m.markLapsedOnChain(...a));
export const boostQueuedOnChain             = (...a) => impl().then(m => m.boostQueuedOnChain(...a));
export const promoteOnChain                 = (...a) => impl().then(m => m.promoteOnChain(...a));

export const waitForTx                      = (...a) => impl().then(m => m.waitForTx(...a));
