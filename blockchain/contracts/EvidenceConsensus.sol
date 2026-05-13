// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title EvidenceConsensus
 * @notice Immutable truth log for the Interstellar Psychology evidence archive.
 *
 * Evidence travels through a 7-state lifecycle:
 *   Submitted → Canon | Expelled | Lapsed
 *   Canon     → Contested
 *   Contested → Deprecated | Reaffirmed
 *
 * ── Genesis bootstrap ───────────────────────────────────────────────────────
 * The system is designed to launch from a single Genesis peer (quorum = 1).
 * All thresholds use a floor of 1 so Genesis can approve evidence, verify
 * nominees, and revoke peers without deadlock.  As more peers join, thresholds
 * scale up automatically.
 *
 * ── Seed phase ──────────────────────────────────────────────────────────────
 * Until activePeerCount reaches `seedPhaseK`, public `nominatePeer` is locked
 * and the only way to add peers is owner-initiated `addPeer`.  This closes the
 * Sybil window where a single Genesis key could otherwise self-promote
 * unlimited sockpuppets through nominate → endorse loops.
 *
 * ── Content hash ────────────────────────────────────────────────────────────
 * Every submission carries an immutable `bytes32 contentHash` — keccak of the
 * canonical evidence payload.  The off-chain store can be re-read against this
 * hash to detect tampering of a canonized claim.
 *
 * ── Off-chain metadata ──────────────────────────────────────────────────────
 * The contract stores only IDs, content hashes, vote counts and state.  Full
 * evidence text and peer profiles live in Supabase; this contract is the
 * unforgeable consensus log.
 *
 * ── Two-step ownership ──────────────────────────────────────────────────────
 * `proposeOwner` → `acceptOwnership` (or `cancelOwnershipTransfer`).  Prevents
 * typo-bricking and ensures the new owner is an address that can act.
 *
 * ── Peer-floor invariant ────────────────────────────────────────────────────
 * `_removePeer` requires `activePeerCount > 1`.  The system always has at
 * least one peer who can submit evidence and vote.  Revocation flows respect
 * the same guard, so a 2-peer network cannot vote itself to zero.
 */
contract EvidenceConsensus {

    // ── State enum ───────────────────────────────────────────────────────────

    enum EvidenceState {
        Submitted,   // 0 — awaiting review votes
        Canon,       // 1 — canonized by peer consensus
        Expelled,    // 2 — rejected by peer consensus
        Lapsed,      // 3 — timed out without reaching threshold
        Contested,   // 4 — canon item under active challenge
        Deprecated,  // 5 — removed by challenge consensus
        Reaffirmed   // 6 — survived challenge, re-confirmed as canon
    }

    // ── Storage ──────────────────────────────────────────────────────────────

    address public owner;
    address public pendingOwner;   // two-step ownership transfer
    address public genesis;        // first peer; set at deployment
    uint256 public immutable seedPhaseK;
    bool    public paused;

    // ── Peer registry ────────────────────────────────────────────────────────
    //
    // _peerList is the dynamic *active* set.  We swap-pop on revoke so the
    // array never bloats with stale addresses.  peerIndex is 1-based: 0 means
    // "not in the list" so we can distinguish from a real slot-0 entry.

    address[] private _peerList;
    mapping(address => uint256) private peerIndex;        // 1-based
    mapping(address => bool)    public isPeer;            // sticky: true once added, never reset
    mapping(address => bool)    public isActivePeer;      // mirrors membership of _peerList
    mapping(address => string)  public peerHandle;
    uint256 public activePeerCount;

    // ── Nominee registry ─────────────────────────────────────────────────────

    address[] private _nomineeList;
    mapping(address => uint256) private nomineeIndex;     // 1-based
    mapping(address => bool)    public isNominated;
    mapping(address => string)  public nomineeHandle;
    mapping(address => address) public nomineeBy;
    mapping(address => uint48)  public nomineeAt;
    mapping(address => uint32)  public nomineeEndorsements;
    mapping(address => mapping(address => bool)) public hasEndorsed;

    // ── Revocation state ─────────────────────────────────────────────────────

    mapping(address => bool)   public revocationActive;
    mapping(address => uint32) public revokeVoteCount;
    mapping(address => mapping(address => bool)) public hasVotedRevoke;

    // ── Challenge rate limiting ──────────────────────────────────────────────

    mapping(address => uint48) public lastChallengeAt;

    // ── Evidence records ─────────────────────────────────────────────────────

    struct EvidenceRecord {
        EvidenceState state;
        uint8   tier;             // 1 | 2 | 3
        uint32  approveCount;
        uint32  rejectCount;
        uint32  challengeVotes;
        uint32  defenseVotes;
        uint48  submittedAt;
        uint48  canonAt;
        uint48  challengedAt;
        bytes32 contentHash;      // keccak of canonical off-chain payload
        bytes32 challengerFirst;  // address-as-bytes32 of challenge opener
    }

    mapping(bytes32 => EvidenceRecord) public records;

    // hasVoted[evidenceId][phase][voter] — phase: 0 = review, 1 = challenge
    mapping(bytes32 => mapping(uint8 => mapping(address => bool))) public hasVoted;

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant PENDING_WINDOW    = 30 days;
    uint256 public constant CHALLENGE_WINDOW  = 21 days;
    uint256 public constant CHALLENGE_COOLDOWN = 7 days;
    /// @notice Hard cap on peer / nominee handle length (in bytes) so the
    /// registry views stay bounded and a clumsy or malicious caller cannot
    /// bloat `getActivePeers` / `getNominees` to multi-megabyte responses.
    uint256 public constant MAX_HANDLE_BYTES  = 64;

    // ── Events ───────────────────────────────────────────────────────────────

    event PeerAdded   (address indexed peer, string handle, uint256 activePeerCount);
    event PeerRemoved (address indexed peer, uint256 activePeerCount);

    event PeerNominated       (address indexed nominee, string handle, address indexed nominatedBy, uint256 threshold);
    event PeerEndorsed        (address indexed nominee, address indexed endorser, uint32 endorsements, uint256 threshold);
    event NomineeVerified     (address indexed peer, string handle, uint256 activePeerCount);

    event RevocationMotioned  (address indexed peer, address indexed by, uint256 threshold);
    event RevocationVoteCast  (address indexed peer, address indexed voter, uint32 votes, uint256 threshold);
    event PeerRevoked         (address indexed peer, uint256 activePeerCount);

    event EvidenceSubmitted  (bytes32 indexed id, uint8 tier, address indexed submitter, bytes32 contentHash);
    event ReviewVoteCast     (bytes32 indexed id, address indexed voter, bool approve, uint32 approveCount, uint32 rejectCount);
    event EvidenceCanonized  (bytes32 indexed id, uint48 canonAt, uint32 approveCount);
    event EvidenceExpelled   (bytes32 indexed id, uint32 rejectCount);
    event EvidenceLapsed     (bytes32 indexed id);

    event ChallengeOpened    (bytes32 indexed id, address indexed challenger, uint48 challengedAt);
    event ChallengeVoteCast  (bytes32 indexed id, address indexed voter, bool supportChallenge, uint32 challengeVotes, uint32 defenseVotes);
    event EvidenceDeprecated (bytes32 indexed id, uint32 challengeVotes);
    event EvidenceReaffirmed (bytes32 indexed id, uint32 defenseVotes);

    event Paused                    (address indexed by);
    event Unpaused                  (address indexed by);
    event OwnershipProposed         (address indexed previousOwner, address indexed proposedOwner);
    event OwnershipTransferred      (address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferCancelled(address indexed by);

    // ── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param genesisPeers Initial active peers.  Must be non-empty.
     * @param handles      Display names, parallel to genesisPeers.
     * @param _seedPhaseK  Minimum activePeerCount before public nominatePeer
     *                     is unlocked.  Set to 0 to disable the seed gate
     *                     (legacy behaviour).  Recommend ≥ 5 for production.
     */
    constructor(
        address[] memory genesisPeers,
        string[]  memory handles,
        uint256          _seedPhaseK
    ) {
        owner       = msg.sender;
        seedPhaseK  = _seedPhaseK;
        require(genesisPeers.length == handles.length, "length mismatch");
        require(genesisPeers.length > 0, "need at least one genesis peer");
        for (uint256 i = 0; i < genesisPeers.length; i++) {
            _addPeer(genesisPeers[i], handles[i]);
        }
        genesis = genesisPeers[0];
    }

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyActivePeer() {
        require(isActivePeer[msg.sender], "not an active peer");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    // ── Owner emergency controls ─────────────────────────────────────────────

    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender);   }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }

    /// @notice Step 1 of 2-step ownership transfer. `proposedOwner` must call
    /// `acceptOwnership()` to finalize. Protects against typos and against
    /// transferring to a contract that cannot accept.
    function proposeOwner(address proposedOwner) external onlyOwner {
        require(proposedOwner != address(0), "zero address");
        require(proposedOwner != owner,       "already owner");
        pendingOwner = proposedOwner;
        emit OwnershipProposed(owner, proposedOwner);
    }

    /// @notice Step 2 of 2-step ownership transfer. Must be called by the
    /// proposed owner; finalizes the transfer.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        address previous = owner;
        owner            = pendingOwner;
        pendingOwner     = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    /// @notice Abort a pending ownership transfer before `acceptOwnership`.
    function cancelOwnershipTransfer() external onlyOwner {
        require(pendingOwner != address(0), "no pending transfer");
        pendingOwner = address(0);
        emit OwnershipTransferCancelled(msg.sender);
    }

    // ── Peer management (owner-only for seed phase and emergency use) ───────

    function addPeer(address peer, string calldata handle) external onlyOwner {
        _addPeer(peer, handle);
    }

    function removePeer(address peer) external onlyOwner {
        _removePeer(peer);
    }

    function _addPeer(address peer, string memory handle) internal {
        require(peer != address(0), "zero address");
        require(!isActivePeer[peer], "already active");
        require(bytes(handle).length <= MAX_HANDLE_BYTES, "handle too long");

        isPeer[peer]       = true;
        isActivePeer[peer] = true;
        peerHandle[peer]   = handle;

        _peerList.push(peer);
        peerIndex[peer] = _peerList.length; // 1-based
        activePeerCount++;

        emit PeerAdded(peer, handle, activePeerCount);
    }

    function _removePeer(address peer) internal {
        require(isActivePeer[peer], "not active");
        require(activePeerCount > 1, "cannot remove last peer");
        uint256 idx = peerIndex[peer];
        require(idx != 0, "not in list");

        uint256 lastIdx = _peerList.length;
        if (idx != lastIdx) {
            address moved = _peerList[lastIdx - 1];
            _peerList[idx - 1] = moved;
            peerIndex[moved]   = idx;
        }
        _peerList.pop();
        peerIndex[peer]    = 0;
        isActivePeer[peer] = false;
        activePeerCount--;

        // Clear in-flight revocation state so re-adding the same address
        // doesn't inherit a stale vote count. Per-voter `hasVotedRevoke`
        // entries cannot be iterated and are accepted as one-shot per
        // address lifetime — re-adding a previously-revoked peer means the
        // same voters cannot vote a second time without a fresh wallet.
        revocationActive[peer] = false;
        revokeVoteCount[peer]  = 0;

        emit PeerRemoved(peer, activePeerCount);
    }

    function peerList() external view returns (address[] memory) {
        return _peerList;
    }

    // ── Genesis helper ───────────────────────────────────────────────────────

    function isGenesisPeer(address addr) external view returns (bool) {
        return addr == genesis;
    }

    // ── Threshold functions ──────────────────────────────────────────────────

    function canonizeThreshold(uint8 tier) public view returns (uint256) {
        uint256 n = activePeerCount;
        uint256 pct;
        if (tier == 1) pct = 45;
        else if (tier == 2) pct = 35;
        else pct = 30;
        uint256 raw = (n * pct + 99) / 100;
        return raw < 1 ? 1 : raw;
    }

    function expelThreshold() public view returns (uint256) {
        uint256 n = activePeerCount;
        uint256 raw = (n * 25 + 99) / 100;
        return raw < 1 ? 1 : raw;
    }

    function deprecateThreshold(uint8 tier) public view returns (uint256) {
        uint256 n = activePeerCount;
        uint256 pct;
        if (tier == 1) pct = 65;
        else if (tier == 2) pct = 60;
        else pct = 55;
        uint256 raw = (n * pct + 99) / 100;
        return raw < 1 ? 1 : raw;
    }

    function nomineeThreshold() public view returns (uint256) {
        uint256 raw = (activePeerCount + 2) / 3; // ceiling(n / 3)
        if (raw < 1) return 1;
        if (raw > 9) return 9;
        return raw;
    }

    function revokeThreshold() public view returns (uint256) {
        uint256 raw = (activePeerCount + 1) / 2; // ceiling(n / 2)
        return raw < 1 ? 1 : raw;
    }

    /// @return open True once `activePeerCount >= seedPhaseK` and public
    /// nominations are unlocked.
    function nominationsOpen() public view returns (bool open) {
        return activePeerCount >= seedPhaseK;
    }

    // ── Nominee flow: nominate → endorse → auto-verify ──────────────────────

    function nominatePeer(address nominee, string calldata handle)
        external onlyActivePeer whenNotPaused
    {
        require(nominationsOpen(), "seed phase: owner must seed peers first");
        require(nominee != address(0), "zero address");
        require(!isActivePeer[nominee], "already a peer");
        require(!isNominated[nominee], "already nominated");
        require(bytes(handle).length <= MAX_HANDLE_BYTES, "handle too long");

        isNominated[nominee]         = true;
        nomineeHandle[nominee]       = handle;
        nomineeBy[nominee]           = msg.sender;
        nomineeAt[nominee]           = uint48(block.timestamp);
        nomineeEndorsements[nominee] = 0;

        _nomineeList.push(nominee);
        nomineeIndex[nominee] = _nomineeList.length; // 1-based

        emit PeerNominated(nominee, handle, msg.sender, nomineeThreshold());
    }

    function endorseNominee(address nominee)
        external onlyActivePeer whenNotPaused
    {
        require(isNominated[nominee], "not nominated");
        require(!hasEndorsed[nominee][msg.sender], "already endorsed");

        hasEndorsed[nominee][msg.sender] = true;
        nomineeEndorsements[nominee]++;

        uint256 threshold = nomineeThreshold();
        emit PeerEndorsed(nominee, msg.sender, nomineeEndorsements[nominee], threshold);

        if (nomineeEndorsements[nominee] >= threshold) {
            string memory handle = nomineeHandle[nominee];
            _removeNominee(nominee);
            _addPeer(nominee, handle);
            emit NomineeVerified(nominee, handle, activePeerCount);
        }
    }

    function _removeNominee(address nominee) internal {
        uint256 idx = nomineeIndex[nominee];
        if (idx == 0) return;
        uint256 lastIdx = _nomineeList.length;
        if (idx != lastIdx) {
            address moved = _nomineeList[lastIdx - 1];
            _nomineeList[idx - 1] = moved;
            nomineeIndex[moved]   = idx;
        }
        _nomineeList.pop();
        nomineeIndex[nominee] = 0;
        isNominated[nominee]  = false;
    }

    function nomineeList() external view returns (address[] memory) {
        return _nomineeList;
    }

    // ── Revocation flow: motion → vote → auto-revoke ─────────────────────────

    function motionRevoke(address peer)
        external onlyActivePeer whenNotPaused
    {
        require(isActivePeer[peer], "not active peer");
        require(!revocationActive[peer], "revocation already active");
        require(peer != msg.sender, "cannot self-revoke");

        revocationActive[peer]            = true;
        revokeVoteCount[peer]             = 1;
        hasVotedRevoke[peer][msg.sender]  = true;

        uint256 threshold = revokeThreshold();
        emit RevocationMotioned(peer, msg.sender, threshold);
        emit RevocationVoteCast(peer, msg.sender, 1, threshold);

        _checkRevocation(peer);
    }

    function voteRevoke(address peer)
        external onlyActivePeer whenNotPaused
    {
        require(revocationActive[peer], "no revocation active");
        require(!hasVotedRevoke[peer][msg.sender], "already voted");

        hasVotedRevoke[peer][msg.sender] = true;
        revokeVoteCount[peer]++;

        emit RevocationVoteCast(peer, msg.sender, revokeVoteCount[peer], revokeThreshold());

        _checkRevocation(peer);
    }

    function _checkRevocation(address peer) internal {
        if (revokeVoteCount[peer] >= revokeThreshold()) {
            revocationActive[peer] = false;
            _removePeer(peer);
            // PeerRemoved is emitted inside _removePeer; emit PeerRevoked for
            // clarity in the indexer (separate event semantics from owner-side
            // removePeer).
            emit PeerRevoked(peer, activePeerCount);
        }
    }

    // ── Submit evidence ──────────────────────────────────────────────────────

    /**
     * @param id          bytes32-encoded Supabase UUID — links on-chain and off-chain records.
     * @param tier        1 (declassified / peer-reviewed), 2 (documented), 3 (testimonial).
     * @param contentHash keccak256 of the canonical off-chain payload at submission time.
     *                    Must be non-zero so off-chain content can be re-derived and verified.
     */
    function submitEvidence(bytes32 id, uint8 tier, bytes32 contentHash)
        external onlyActivePeer whenNotPaused
    {
        require(records[id].submittedAt == 0, "already submitted");
        require(tier >= 1 && tier <= 3, "invalid tier");
        require(contentHash != bytes32(0), "empty content hash");

        records[id] = EvidenceRecord({
            state:           EvidenceState.Submitted,
            tier:            tier,
            approveCount:    0,
            rejectCount:     0,
            challengeVotes:  0,
            defenseVotes:    0,
            submittedAt:     uint48(block.timestamp),
            canonAt:         0,
            challengedAt:    0,
            contentHash:     contentHash,
            challengerFirst: bytes32(0)
        });

        emit EvidenceSubmitted(id, tier, msg.sender, contentHash);
    }

    // ── Review voting ────────────────────────────────────────────────────────

    /// @notice Hard cap on a single batched review-vote call so the
    /// transaction stays under realistic gas limits and an oversize batch
    /// cannot be used to grief the mempool.
    uint256 public constant MAX_REVIEW_BATCH = 50;

    function castReviewVote(bytes32 id, bool approve)
        external onlyActivePeer whenNotPaused
    {
        _castReviewVote(id, approve);
    }

    /// @notice Batch the same caller's votes across many pending items in a
    /// single transaction.  Each (id, approve) pair is treated independently
    /// and gives the same emissions as if `castReviewVote` had been called
    /// individually.  Reverts atomically on any single bad entry — the caller
    /// is expected to pre-filter the queue locally (the frontend already
    /// knows which items they haven't voted on).
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
        EvidenceRecord storage r = records[id];
        require(r.submittedAt != 0, "unknown evidence");
        require(r.state == EvidenceState.Submitted, "not in review");
        require(!hasVoted[id][0][msg.sender], "already voted");

        hasVoted[id][0][msg.sender] = true;

        if (approve) r.approveCount++;
        else         r.rejectCount++;

        emit ReviewVoteCast(id, msg.sender, approve, r.approveCount, r.rejectCount);

        if (r.approveCount >= canonizeThreshold(r.tier)) {
            r.state   = EvidenceState.Canon;
            r.canonAt = uint48(block.timestamp);
            emit EvidenceCanonized(id, r.canonAt, r.approveCount);
        } else if (r.rejectCount >= expelThreshold()) {
            r.state = EvidenceState.Expelled;
            emit EvidenceExpelled(id, r.rejectCount);
        }
    }

    function markLapsed(bytes32 id) external onlyActivePeer {
        EvidenceRecord storage r = records[id];
        require(r.state == EvidenceState.Submitted, "not pending");
        require(block.timestamp > r.submittedAt + PENDING_WINDOW, "window still open");
        r.state = EvidenceState.Lapsed;
        emit EvidenceLapsed(id);
    }

    // ── Challenge system ─────────────────────────────────────────────────────

    function openChallenge(bytes32 id)
        external onlyActivePeer whenNotPaused
    {
        require(
            lastChallengeAt[msg.sender] == 0 ||
            block.timestamp > uint256(lastChallengeAt[msg.sender]) + CHALLENGE_COOLDOWN,
            "challenge cooldown active"
        );

        EvidenceRecord storage r = records[id];
        require(
            r.state == EvidenceState.Canon || r.state == EvidenceState.Reaffirmed,
            "not canon"
        );

        r.state           = EvidenceState.Contested;
        r.challengedAt    = uint48(block.timestamp);
        r.challengeVotes  = 1;
        r.defenseVotes    = 0;
        r.challengerFirst = bytes32(uint256(uint160(msg.sender)));

        hasVoted[id][1][msg.sender] = true;
        lastChallengeAt[msg.sender] = uint48(block.timestamp);

        emit ChallengeOpened(id, msg.sender, r.challengedAt);
        emit ChallengeVoteCast(id, msg.sender, true, r.challengeVotes, r.defenseVotes);

        _resolveChallenge(id, r);
    }

    function castChallengeVote(bytes32 id, bool supportChallenge)
        external onlyActivePeer whenNotPaused
    {
        EvidenceRecord storage r = records[id];
        require(r.state == EvidenceState.Contested, "not contested");
        require(!hasVoted[id][1][msg.sender], "already voted");
        require(block.timestamp <= r.challengedAt + CHALLENGE_WINDOW, "window expired");

        hasVoted[id][1][msg.sender] = true;

        if (supportChallenge) r.challengeVotes++;
        else                  r.defenseVotes++;

        emit ChallengeVoteCast(id, msg.sender, supportChallenge, r.challengeVotes, r.defenseVotes);

        _resolveChallenge(id, r);
    }

    /// @notice Finalize a contested piece after the 21-day window.  Anyone
    /// (peer or not) can call — pure bookkeeping.
    function finalizeChallenge(bytes32 id) external {
        EvidenceRecord storage r = records[id];
        require(r.state == EvidenceState.Contested, "not contested");
        require(block.timestamp > r.challengedAt + CHALLENGE_WINDOW, "window still open");
        _resolveChallenge(id, r);
    }

    /**
     * Resolution rules:
     *   - Deprecate IMMEDIATELY when challenge votes reach threshold (mid-window).
     *   - Otherwise wait for the window to expire, then deterministically:
     *       challenge < threshold AND defense >  challenge → Reaffirmed
     *       challenge < threshold AND defense <= challenge → Reaffirmed
     *         (silence does not deprecate — canon survives if no deprecation
     *          quorum is reached.  Resolves the previous "stuck contested
     *          forever" case.)
     *   - challenge ≥ threshold can be hit only when supportChallenge votes
     *     accumulate; deprecation always wins over defense.
     */
    function _resolveChallenge(bytes32 id, EvidenceRecord storage r) internal {
        if (r.challengeVotes >= deprecateThreshold(r.tier)) {
            r.state = EvidenceState.Deprecated;
            emit EvidenceDeprecated(id, r.challengeVotes);
            return;
        }
        if (block.timestamp > r.challengedAt + CHALLENGE_WINDOW) {
            r.state = EvidenceState.Reaffirmed;
            emit EvidenceReaffirmed(id, r.defenseVotes);
        }
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @dev Returns seconds until `peer` can open another challenge (0 = available now).
    function challengeCooldownRemaining(address peer) external view returns (uint256) {
        if (lastChallengeAt[peer] == 0) return 0;
        uint256 cooldownEnd = uint256(lastChallengeAt[peer]) + CHALLENGE_COOLDOWN;
        if (block.timestamp >= cooldownEnd) return 0;
        return cooldownEnd - block.timestamp;
    }

    function getRecord(bytes32 id) external view returns (EvidenceRecord memory) {
        return records[id];
    }

    function getThresholds(bytes32 id) external view returns (
        uint256 canonThresh, uint256 expelThresh, uint256 deprecThresh
    ) {
        uint8 tier = records[id].tier;
        return (canonizeThreshold(tier), expelThreshold(), deprecateThreshold(tier));
    }

    function getAllThresholds() external view returns (
        uint256 nomThresh, uint256 revThresh,
        uint256 canon1, uint256 canon2, uint256 canon3,
        uint256 expel,
        uint256 dep1, uint256 dep2, uint256 dep3
    ) {
        return (
            nomineeThreshold(), revokeThreshold(),
            canonizeThreshold(1), canonizeThreshold(2), canonizeThreshold(3),
            expelThreshold(),
            deprecateThreshold(1), deprecateThreshold(2), deprecateThreshold(3)
        );
    }

    /// @notice Aggregated peer-registry view for multicall-free frontend fetches.
    /// Returns parallel arrays for every entry in the active list.  Front-end
    /// can render the whole table from a single eth_call instead of N×5.
    function getActivePeers() external view returns (
        address[] memory addrs,
        string[]  memory handles,
        bool[]    memory revActive,
        uint32[]  memory revVotes
    ) {
        uint256 n = _peerList.length;
        addrs     = new address[](n);
        handles   = new string[](n);
        revActive = new bool[](n);
        revVotes  = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            address a   = _peerList[i];
            addrs[i]    = a;
            handles[i]  = peerHandle[a];
            revActive[i]= revocationActive[a];
            revVotes[i] = revokeVoteCount[a];
        }
    }

    /// @notice Aggregated nominee view — same idea, single eth_call.
    function getNominees() external view returns (
        address[] memory addrs,
        string[]  memory handles,
        uint32[]  memory endorsements
    ) {
        uint256 n = _nomineeList.length;
        addrs        = new address[](n);
        handles      = new string[](n);
        endorsements = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            address a       = _nomineeList[i];
            addrs[i]        = a;
            handles[i]      = nomineeHandle[a];
            endorsements[i] = nomineeEndorsements[a];
        }
    }
}
