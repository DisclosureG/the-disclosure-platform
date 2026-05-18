// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IEvidenceConsensusPeers
 * @notice Read-only interface to the EvidenceConsensus peer registry, used by
 *         sibling contracts (e.g. BehaviourConsensus) that share the same
 *         active-peer set without duplicating registry storage.
 *
 * Only methods needed for membership and quorum scaling are exposed. Peer
 * governance (nominate / endorse / motion / revoke) stays inside the source
 * contract — sibling contracts read membership and never mutate it.
 */
interface IEvidenceConsensusPeers {
    function activePeerCount() external view returns (uint256);
    function isActivePeer(address peer) external view returns (bool);
    function isPeer(address peer) external view returns (bool);
    function peerHandle(address peer) external view returns (string memory);
    function isGenesisPeer(address addr) external view returns (bool);
}
