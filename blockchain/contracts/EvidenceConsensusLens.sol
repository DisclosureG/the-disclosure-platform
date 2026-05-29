// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./EvidenceConsensus.sol";
import "./PeerGovernance.sol";

/// @title EvidenceConsensusLens
/// @notice Read-only sidecar for {EvidenceConsensus}.  These aggregation views
/// were moved off the core contract's runtime to keep it under the EIP-170
/// 24576-byte limit while the on-chain peer garbage collection and submission
/// queue were added.  The Lens reconstructs each aggregate purely from the
/// core's PUBLIC state, so it holds no storage, has no privileges, and carries
/// zero consensus risk — the core remains the sole source of truth and the only
/// contract that mutates state.  Deploy after the core and point read clients
/// (the frontend) at this address for these views.
///
/// The nominee / revocation state now lives in {PeerGovernance}, so the Lens also
/// holds that address and reads those aggregates from it.
contract EvidenceConsensusLens {
    EvidenceConsensus public immutable core;
    PeerGovernance    public immutable gov;

    constructor(EvidenceConsensus _core, PeerGovernance _gov) {
        core = _core;
        gov  = _gov;
    }

    /// @notice Genesis check (core.genesis() is public).
    function isGenesisPeer(address addr) external view returns (bool) {
        return addr == core.genesis();
    }

    /// @notice Seconds left on a peer's per-peer challenge cooldown, or 0.
    function challengeCooldownRemaining(address peer) external view returns (uint256) {
        uint256 last = core.lastChallengeAt(peer);
        if (last == 0) return 0;
        uint256 cooldownEnd = last + core.CHALLENGE_COOLDOWN();
        if (block.timestamp >= cooldownEnd) return 0;
        return cooldownEnd - block.timestamp;
    }

    /// @notice Seconds left on a wallet's per-address public-boost cooldown, or 0.
    /// Active peers are exempt from the cooldown, so always 0 for them.
    function boostCooldownRemaining(address account) external view returns (uint256) {
        if (core.isActivePeer(account)) return 0;
        uint256 last = core.lastBoostAt(account);
        if (last == 0) return 0;
        uint256 cooldownEnd = last + core.BOOST_COOLDOWN();
        if (block.timestamp >= cooldownEnd) return 0;
        return cooldownEnd - block.timestamp;
    }

    /// @notice Active peer set with handle, revocation status, and the liveness
    /// clock used by automatic garbage collection (lastActive).
    function getActivePeers() external view returns (
        address[] memory addrs,
        string[]  memory handles,
        bool[]    memory revActive,
        uint32[]  memory revVotes,
        uint48[]  memory lastActives
    ) {
        addrs = core.peerList();
        uint256 n = addrs.length;
        handles     = new string[](n);
        revActive   = new bool[](n);
        revVotes    = new uint32[](n);
        lastActives = new uint48[](n);
        for (uint256 i = 0; i < n; i++) {
            address a = addrs[i];
            handles[i]     = core.peerHandle(a);
            revActive[i]   = gov.revocationActive(a);
            revVotes[i]    = gov.revokeVoteCount(a);
            lastActives[i] = core.lastActive(a);
        }
    }

    /// @notice Pending nominees with handle and endorsement tally.
    function getNominees() external view returns (
        address[] memory addrs,
        string[]  memory handles,
        uint32[]  memory endorsements
    ) {
        addrs = gov.nomineeList();
        uint256 n = addrs.length;
        handles      = new string[](n);
        endorsements = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            address a = addrs[i];
            handles[i]      = gov.nomineeHandle(a);
            endorsements[i] = gov.nomineeEndorsements(a);
        }
    }

    /// @notice Pending taxonomy proposals (pillars + topics), rebuilt from the
    /// core's raw proposal id list joined to getTaxonomyNode().
    function getProposedNodes() external view returns (
        bytes32[] memory ids,
        uint8[]   memory kinds,
        bytes32[] memory parents,
        bytes32[] memory metaHashes,
        address[] memory proposers,
        uint32[]  memory endorsements,
        uint32[]  memory rejections
    ) {
        ids = core.proposedNodeIds();
        uint256 n = ids.length;
        kinds        = new uint8[](n);
        parents      = new bytes32[](n);
        metaHashes   = new bytes32[](n);
        proposers    = new address[](n);
        endorsements = new uint32[](n);
        rejections   = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            EvidenceConsensus.TaxonomyNode memory node = core.getTaxonomyNode(ids[i]);
            kinds[i]        = uint8(node.kind);
            parents[i]      = node.parent;
            metaHashes[i]   = node.metaHash;
            proposers[i]    = node.proposedBy;
            endorsements[i] = node.endorsements;
            rejections[i]   = node.rejections;
        }
    }

    // ── Paginated variants ────────────────────────────────────────────────────
    //
    // The full getters above do one-or-more external reads per list element and
    // are unbounded; as the peer / nominee / proposal sets grow they can approach
    // the eth_call gas cap and revert.  These count getters + windowed variants
    // let a client page through in fixed-size chunks.  A `limit` window that runs
    // past the end is clamped, so `getXPage(offset, limit)` is always safe to call.

    function peerCount()         external view returns (uint256) { return core.peerList().length; }
    function nomineeCount()      external view returns (uint256) { return gov.nomineeList().length; }
    function proposedNodeCount() external view returns (uint256) { return core.proposedNodeIds().length; }

    /// @dev Resolve [offset, offset+limit) against `len`, clamped to `len`.
    function _window(uint256 len, uint256 offset, uint256 limit) internal pure returns (uint256 start, uint256 count) {
        if (offset >= len) return (len, 0);
        uint256 end = offset + limit;
        if (end > len) end = len;
        return (offset, end - offset);
    }

    /// @notice A window of the active peer set (see getActivePeers).
    function getActivePeersPage(uint256 offset, uint256 limit) external view returns (
        address[] memory addrs,
        string[]  memory handles,
        bool[]    memory revActive,
        uint32[]  memory revVotes,
        uint48[]  memory lastActives
    ) {
        address[] memory all = core.peerList();
        (uint256 start, uint256 m) = _window(all.length, offset, limit);
        addrs = new address[](m); handles = new string[](m); revActive = new bool[](m);
        revVotes = new uint32[](m); lastActives = new uint48[](m);
        for (uint256 i = 0; i < m; i++) {
            address a = all[start + i];
            addrs[i]       = a;
            handles[i]     = core.peerHandle(a);
            revActive[i]   = gov.revocationActive(a);
            revVotes[i]    = gov.revokeVoteCount(a);
            lastActives[i] = core.lastActive(a);
        }
    }

    /// @notice A window of pending nominees (see getNominees).
    function getNomineesPage(uint256 offset, uint256 limit) external view returns (
        address[] memory addrs,
        string[]  memory handles,
        uint32[]  memory endorsements
    ) {
        address[] memory all = gov.nomineeList();
        (uint256 start, uint256 m) = _window(all.length, offset, limit);
        addrs = new address[](m); handles = new string[](m); endorsements = new uint32[](m);
        for (uint256 i = 0; i < m; i++) {
            address a = all[start + i];
            addrs[i]        = a;
            handles[i]      = gov.nomineeHandle(a);
            endorsements[i] = gov.nomineeEndorsements(a);
        }
    }

    /// @notice A window of pending taxonomy proposals (see getProposedNodes).
    function getProposedNodesPage(uint256 offset, uint256 limit) external view returns (
        bytes32[] memory ids,
        uint8[]   memory kinds,
        bytes32[] memory parents,
        bytes32[] memory metaHashes,
        address[] memory proposers,
        uint32[]  memory endorsements,
        uint32[]  memory rejections
    ) {
        bytes32[] memory all = core.proposedNodeIds();
        (uint256 start, uint256 m) = _window(all.length, offset, limit);
        ids = new bytes32[](m); kinds = new uint8[](m); parents = new bytes32[](m);
        metaHashes = new bytes32[](m); proposers = new address[](m);
        endorsements = new uint32[](m); rejections = new uint32[](m);
        for (uint256 i = 0; i < m; i++) {
            bytes32 id = all[start + i];
            EvidenceConsensus.TaxonomyNode memory node = core.getTaxonomyNode(id);
            ids[i]          = id;
            kinds[i]        = uint8(node.kind);
            parents[i]      = node.parent;
            metaHashes[i]   = node.metaHash;
            proposers[i]    = node.proposedBy;
            endorsements[i] = node.endorsements;
            rejections[i]   = node.rejections;
        }
    }
}
