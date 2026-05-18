// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IEvidenceConsensusPeers } from "./IEvidenceConsensusPeers.sol";

/**
 * @title BehaviourConsensus
 * @notice Immutable consensus log for the Interstellar Psychology alignment
 *         archive — AI behaviour records voted on by the same peer network
 *         that maintains the evidence archive.
 *
 * A behaviour record is a single (model, input, output) tuple. Three keccak256
 * fingerprints bind the on-chain verdict to a specific model deployment, a
 * specific request, and a specific response. Peers vote `aligned` or
 * `misaligned` under the same 7-state lifecycle as EvidenceConsensus:
 *
 *   Submitted → Aligned | Misaligned | Lapsed
 *   Aligned   → Contested
 *   Contested → Deprecated | Reaffirmed
 *
 * ── Peer source ────────────────────────────────────────────────────────────
 * This contract does NOT maintain its own peer registry. At construction it
 * stores an immutable reference to an `IEvidenceConsensusPeers` source (the
 * deployed EvidenceConsensus) and reads `isActivePeer` / `activePeerCount`
 * across the contract boundary on every state-changing call. Revocations
 * performed against the source contract propagate immediately — there is only
 * one source of truth for who is a peer.
 *
 * ── Pause isolation ────────────────────────────────────────────────────────
 * The source contract's pause flag does NOT pause this contract, and vice
 * versa. Each contract owns its own emergency stop. This is intentional —
 * the alignment archive should keep operating if the evidence archive is
 * paused for unrelated reasons, and vice versa.
 *
 * ── Triple hash ────────────────────────────────────────────────────────────
 * Each record carries `modelHash`, `inputHash`, and `outputHash` separately
 * (not a single concatenated hash) so a downstream audit can re-derive any
 * of the three from off-chain payloads independently. All three must be
 * non-zero at submission.
 *
 * ── Two-step ownership ─────────────────────────────────────────────────────
 * `proposeOwner` → `acceptOwnership` (or `cancelOwnershipTransfer`).
 */
contract BehaviourConsensus {

    // ── State enum (numeric values identical to EvidenceConsensus) ───────────

    enum BehaviourState {
        Submitted,   // 0 — awaiting review votes
        Aligned,     // 1 — endorsed by peer consensus
        Misaligned,  // 2 — rejected by peer consensus
        Lapsed,      // 3 — timed out without reaching threshold
        Contested,   // 4 — aligned record under active challenge
        Deprecated,  // 5 — removed by challenge consensus
        Reaffirmed   // 6 — survived challenge, re-confirmed as aligned
    }

    // ── Storage ──────────────────────────────────────────────────────────────

    address public owner;
    address public pendingOwner;   // two-step ownership transfer
    bool    public paused;

    IEvidenceConsensusPeers public immutable peers;

    // Challenge rate limiting — per-peer, this contract only
    mapping(address => uint48) public lastChallengeAt;

    // ── Behaviour records ────────────────────────────────────────────────────

    struct BehaviourRecord {
        BehaviourState state;
        uint8   tier;             // 1 | 2 | 3
        uint8   domain;           // 1..9 (alignment pillar)
        uint32  approveCount;
        uint32  rejectCount;
        uint32  challengeVotes;
        uint32  defenseVotes;
        uint48  submittedAt;
        uint48  canonAt;          // timestamp at Aligned transition
        uint48  challengedAt;
        bytes32 modelHash;        // keccak of model weights digest / deployment id
        bytes32 inputHash;        // keccak of canonical prompt + context bundle
        bytes32 outputHash;       // keccak of canonical response + side-effects
        bytes32 challengerFirst;  // address-as-bytes32 of challenge opener
    }

    mapping(bytes32 => BehaviourRecord) public records;

    // hasVoted[behaviourId][phase][voter] — phase: 0 = review, 1 = challenge
    mapping(bytes32 => mapping(uint8 => mapping(address => bool))) public hasVoted;

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant PENDING_WINDOW     = 30 days;
    uint256 public constant CHALLENGE_WINDOW   = 21 days;
    uint256 public constant CHALLENGE_COOLDOWN = 7 days;
    uint256 public constant MAX_REVIEW_BATCH   = 50;
    uint256 public constant MAX_GROUNDS_BYTES  = 1024;

    uint8   public constant MIN_DOMAIN = 1;
    uint8   public constant MAX_DOMAIN = 9;

    // ── Events ───────────────────────────────────────────────────────────────

    event BehaviourSubmitted (
        bytes32 indexed id,
        uint8 tier,
        uint8 domain,
        address indexed submitter,
        bytes32 modelHash,
        bytes32 inputHash,
        bytes32 outputHash
    );
    event ReviewVoteCast     (bytes32 indexed id, address indexed voter, bool approve, uint32 approveCount, uint32 rejectCount);
    event BehaviourAligned   (bytes32 indexed id, uint48 canonAt, uint32 approveCount);
    event BehaviourMisaligned(bytes32 indexed id, uint32 rejectCount);
    event BehaviourLapsed    (bytes32 indexed id);

    event ChallengeOpened    (bytes32 indexed id, address indexed challenger, uint48 challengedAt, string grounds);
    event ChallengeVoteCast  (bytes32 indexed id, address indexed voter, bool supportChallenge, uint32 challengeVotes, uint32 defenseVotes);
    event BehaviourDeprecated(bytes32 indexed id, uint32 challengeVotes);
    event BehaviourReaffirmed(bytes32 indexed id, uint32 defenseVotes);

    event Paused                    (address indexed by);
    event Unpaused                  (address indexed by);
    event OwnershipProposed         (address indexed previousOwner, address indexed proposedOwner);
    event OwnershipTransferred      (address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferCancelled(address indexed by);

    // ── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param peerSource Address of the deployed EvidenceConsensus contract whose
     *                   peer registry will be read across the boundary. Must be
     *                   non-zero. The address is immutable — re-pointing requires
     *                   redeploying this contract.
     */
    constructor(address peerSource) {
        require(peerSource != address(0), "zero peer source");
        owner = msg.sender;
        peers = IEvidenceConsensusPeers(peerSource);
    }

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyActivePeer() {
        require(peers.isActivePeer(msg.sender), "not an active peer");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    // ── Owner emergency controls ─────────────────────────────────────────────

    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender);   }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }

    function proposeOwner(address proposedOwner) external onlyOwner {
        require(proposedOwner != address(0), "zero address");
        require(proposedOwner != owner,       "already owner");
        pendingOwner = proposedOwner;
        emit OwnershipProposed(owner, proposedOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        address previous = owner;
        owner            = pendingOwner;
        pendingOwner     = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    function cancelOwnershipTransfer() external onlyOwner {
        require(pendingOwner != address(0), "no pending transfer");
        pendingOwner = address(0);
        emit OwnershipTransferCancelled(msg.sender);
    }

    // ── Threshold functions ──────────────────────────────────────────────────
    //
    // Identical fractions and floor-of-1 logic to EvidenceConsensus, reading
    // activePeerCount across the boundary from the peer source contract.

    function canonizeThreshold(uint8 tier) public view returns (uint256) {
        uint256 n = peers.activePeerCount();
        uint256 pct;
        if (tier == 1) pct = 45;
        else if (tier == 2) pct = 35;
        else pct = 30;
        uint256 raw = (n * pct + 99) / 100;
        return raw < 1 ? 1 : raw;
    }

    function expelThreshold() public view returns (uint256) {
        uint256 n = peers.activePeerCount();
        uint256 raw = (n * 25 + 99) / 100;
        return raw < 1 ? 1 : raw;
    }

    function deprecateThreshold(uint8 tier) public view returns (uint256) {
        uint256 n = peers.activePeerCount();
        uint256 pct;
        if (tier == 1) pct = 65;
        else if (tier == 2) pct = 60;
        else pct = 55;
        uint256 raw = (n * pct + 99) / 100;
        return raw < 1 ? 1 : raw;
    }

    // ── Submit behaviour ─────────────────────────────────────────────────────

    /**
     * @param id         bytes32-encoded Supabase UUID — links on-chain to off-chain.
     * @param tier       1 (reproducible eval), 2 (institutional audit), 3 (first-person report).
     * @param domain     1..9 — one of the nine alignment pillars.
     * @param modelHash  keccak of model weights digest / verifier-attested deployment id.
     * @param inputHash  keccak of canonical input bundle (prompt + tools + context).
     * @param outputHash keccak of canonical output bundle (response + side-effects).
     *                   All three hashes must be non-zero.
     */
    function submitBehaviour(
        bytes32 id,
        uint8   tier,
        uint8   domain,
        bytes32 modelHash,
        bytes32 inputHash,
        bytes32 outputHash
    ) external onlyActivePeer whenNotPaused {
        require(records[id].submittedAt == 0, "already submitted");
        require(tier >= 1 && tier <= 3, "invalid tier");
        require(domain >= MIN_DOMAIN && domain <= MAX_DOMAIN, "invalid domain");
        require(modelHash  != bytes32(0), "empty model hash");
        require(inputHash  != bytes32(0), "empty input hash");
        require(outputHash != bytes32(0), "empty output hash");

        // Write directly to storage to avoid stack pressure from a 14-field
        // memory-struct initializer. The default value of every numeric and
        // bytes32 slot in a fresh mapping entry is 0, so we only set the
        // non-zero fields.
        BehaviourRecord storage r = records[id];
        r.state       = BehaviourState.Submitted;
        r.tier        = tier;
        r.domain      = domain;
        r.submittedAt = uint48(block.timestamp);
        r.modelHash   = modelHash;
        r.inputHash   = inputHash;
        r.outputHash  = outputHash;

        emit BehaviourSubmitted(id, tier, domain, msg.sender, modelHash, inputHash, outputHash);
    }

    // ── Review voting ────────────────────────────────────────────────────────

    function castReviewVote(bytes32 id, bool approve)
        external onlyActivePeer whenNotPaused
    {
        _castReviewVote(id, approve);
    }

    function castReviewVoteBatch(bytes32[] calldata ids, bool[] calldata approves)
        external onlyActivePeer whenNotPaused
    {
        uint256 n = ids.length;
        require(n == approves.length, "length mismatch");
        require(n > 0, "empty batch");
        require(n <= MAX_REVIEW_BATCH, "batch too large");
        for (uint256 i = 0; i < n; i++) {
            _castReviewVote(ids[i], approves[i]);
        }
    }

    function _castReviewVote(bytes32 id, bool approve) internal {
        BehaviourRecord storage r = records[id];
        require(r.submittedAt != 0, "unknown behaviour");
        require(r.state == BehaviourState.Submitted, "not in review");
        require(!hasVoted[id][0][msg.sender], "already voted");

        hasVoted[id][0][msg.sender] = true;

        if (approve) r.approveCount++;
        else         r.rejectCount++;

        emit ReviewVoteCast(id, msg.sender, approve, r.approveCount, r.rejectCount);

        if (r.approveCount >= canonizeThreshold(r.tier)) {
            r.state   = BehaviourState.Aligned;
            r.canonAt = uint48(block.timestamp);
            emit BehaviourAligned(id, r.canonAt, r.approveCount);
        } else if (r.rejectCount >= expelThreshold()) {
            r.state = BehaviourState.Misaligned;
            emit BehaviourMisaligned(id, r.rejectCount);
        }
    }

    function markLapsed(bytes32 id) external onlyActivePeer {
        BehaviourRecord storage r = records[id];
        require(r.state == BehaviourState.Submitted, "not pending");
        require(block.timestamp > r.submittedAt + PENDING_WINDOW, "window still open");
        r.state = BehaviourState.Lapsed;
        emit BehaviourLapsed(id);
    }

    // ── Challenge system ─────────────────────────────────────────────────────

    /**
     * @param id       Behaviour record id (must be Aligned or Reaffirmed).
     * @param grounds  Written explanation of the challenge. Emitted in the
     *                 `ChallengeOpened` event for indexer projection — NOT
     *                 stored on-chain (gas).
     */
    function openChallenge(bytes32 id, string calldata grounds)
        external onlyActivePeer whenNotPaused
    {
        require(bytes(grounds).length <= MAX_GROUNDS_BYTES, "grounds too long");
        require(
            lastChallengeAt[msg.sender] == 0 ||
            block.timestamp > uint256(lastChallengeAt[msg.sender]) + CHALLENGE_COOLDOWN,
            "challenge cooldown active"
        );

        BehaviourRecord storage r = records[id];
        require(
            r.state == BehaviourState.Aligned || r.state == BehaviourState.Reaffirmed,
            "not aligned"
        );

        r.state           = BehaviourState.Contested;
        r.challengedAt    = uint48(block.timestamp);
        r.challengeVotes  = 1;
        r.defenseVotes    = 0;
        r.challengerFirst = bytes32(uint256(uint160(msg.sender)));

        hasVoted[id][1][msg.sender] = true;
        lastChallengeAt[msg.sender] = uint48(block.timestamp);

        emit ChallengeOpened(id, msg.sender, r.challengedAt, grounds);
        emit ChallengeVoteCast(id, msg.sender, true, r.challengeVotes, r.defenseVotes);

        _resolveChallenge(id, r);
    }

    function castChallengeVote(bytes32 id, bool supportChallenge)
        external onlyActivePeer whenNotPaused
    {
        BehaviourRecord storage r = records[id];
        require(r.state == BehaviourState.Contested, "not contested");
        require(!hasVoted[id][1][msg.sender], "already voted");
        require(block.timestamp <= r.challengedAt + CHALLENGE_WINDOW, "window expired");

        hasVoted[id][1][msg.sender] = true;

        if (supportChallenge) r.challengeVotes++;
        else                  r.defenseVotes++;

        emit ChallengeVoteCast(id, msg.sender, supportChallenge, r.challengeVotes, r.defenseVotes);

        _resolveChallenge(id, r);
    }

    /// @notice Finalize a contested record after the 21-day window. Anyone may call.
    function finalizeChallenge(bytes32 id) external {
        BehaviourRecord storage r = records[id];
        require(r.state == BehaviourState.Contested, "not contested");
        require(block.timestamp > r.challengedAt + CHALLENGE_WINDOW, "window still open");
        _resolveChallenge(id, r);
    }

    function _resolveChallenge(bytes32 id, BehaviourRecord storage r) internal {
        if (r.challengeVotes >= deprecateThreshold(r.tier)) {
            r.state = BehaviourState.Deprecated;
            emit BehaviourDeprecated(id, r.challengeVotes);
            return;
        }
        if (block.timestamp > r.challengedAt + CHALLENGE_WINDOW) {
            r.state = BehaviourState.Reaffirmed;
            emit BehaviourReaffirmed(id, r.defenseVotes);
        }
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function challengeCooldownRemaining(address peer) external view returns (uint256) {
        if (lastChallengeAt[peer] == 0) return 0;
        uint256 cooldownEnd = uint256(lastChallengeAt[peer]) + CHALLENGE_COOLDOWN;
        if (block.timestamp >= cooldownEnd) return 0;
        return cooldownEnd - block.timestamp;
    }

    function getRecord(bytes32 id) external view returns (BehaviourRecord memory) {
        return records[id];
    }

    function getThresholds(bytes32 id) external view returns (
        uint256 canonThresh, uint256 expelThresh, uint256 deprecThresh
    ) {
        uint8 tier = records[id].tier;
        return (canonizeThreshold(tier), expelThreshold(), deprecateThreshold(tier));
    }

    function getAllThresholds() external view returns (
        uint256 canon1, uint256 canon2, uint256 canon3,
        uint256 expel,
        uint256 dep1, uint256 dep2, uint256 dep3
    ) {
        return (
            canonizeThreshold(1), canonizeThreshold(2), canonizeThreshold(3),
            expelThreshold(),
            deprecateThreshold(1), deprecateThreshold(2), deprecateThreshold(3)
        );
    }

    /// @notice Convenience: canonical triple-hash recomputation. Off-chain
    /// auditors can use the same formula to verify their reconstruction
    /// matches what was submitted. The order (model, input, output) is part
    /// of the protocol — changing it would invalidate every audit.
    function tripleHash(bytes32 modelHash, bytes32 inputHash, bytes32 outputHash)
        external pure returns (bytes32)
    {
        return keccak256(abi.encodePacked(modelHash, inputHash, outputHash));
    }
}
