// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title EvidenceConsensus
 * @notice Immutable truth log for the Disclosure Platform evidence archive.
 *
 * ── Evidence × (pillar → topic) bindings ────────────────────────────────────
 * A single piece of evidence has ONE canonical id and ONE content hash, but it
 * can be filed under any number of taxonomy topics.  Each (evidence, topic)
 * pair is a *binding* — an independent voting unit with its own 7-state
 * lifecycle, its own tallies, and its own challenge window.  Only the bindings
 * that pass review enter the public archive; rejected bindings stay on-chain
 * for transparency.  The same evidence can therefore be canon under one topic
 * and expelled under another.
 *
 *   bindingId = keccak256(abi.encode(evidenceId, topicId))
 *
 * Each binding travels:
 *   Submitted → Canon | Expelled | Lapsed
 *   Canon     → Contested
 *   Contested → Deprecated | Reaffirmed
 *
 * ── Non-empty taxonomy ──────────────────────────────────────────────────────
 * The taxonomy is never scaffolding without content.  A pillar is proposed
 * together with its first topic AND a first piece of evidence; a topic is
 * proposed together with a first piece of evidence.  The whole bundle rides on
 * one endorsement gate: when the proposed node reaches `bundleThreshold`, the
 * node ratifies, the founding topic (for a pillar) ratifies, and the founding
 * evidence's (evidence, topic) binding is canonized — atomically.  The founding
 * evidence is NOT exempt from review-grade consensus: the bundle gate is
 * `max(taxonomyThreshold, canonizeThreshold(tier))`, so smuggling evidence in
 * as a thin "new topic" is no cheaper than the normal review path.  Further
 * evidence is added to a ratified topic with `submitEvidence` / `fileBinding`,
 * which still pass through the normal tier-based review.
 *
 * ── Fully trustless after seed ──────────────────────────────────────────────
 * The system launches from a Genesis peer set (quorum floors at 1 so a small
 * network can act).  The owner may only `addPeer` DURING the seed phase
 * (activePeerCount < seedPhaseK); once the network opens, membership is
 * community-driven (nominate/endorse) and the ONLY way to remove a peer is the
 * revocation vote — the owner has no unilateral membership power.  After the
 * seed phase the owner may `renounceOwnership()` to cement trustlessness.
 *
 * Capture boundary: admission requires `floor(n/3)+1` endorsements (STRICTLY
 * more than 1/3), so a coalition with ≤ 1/3 of peers cannot grow itself without
 * honest cooperation (a BFT-style "honest > 2/3" assumption).  Revocation needs a
 * majority; retiring a ratified taxonomy node needs a `ceil(2n/3)` supermajority.
 *
 * ── Content hash ────────────────────────────────────────────────────────────
 * Every evidence carries an immutable `bytes32 contentHash` — keccak of the
 * canonical off-chain payload (content only; the binding set is NOT part of the
 * hash, so cross-listing a record never changes its hash).  A founding evidence
 * id is reserved from proposal until ratification or lapse, so a concurrent
 * `submitEvidence`/bundle can never race in and overwrite the record.
 *
 * ── Off-chain metadata ──────────────────────────────────────────────────────
 * The contract stores only ids, content hashes, vote counts and state.  Full
 * text and peer profiles live in Supabase; this contract is the unforgeable log.
 *
 * ── Open-submission front-running (known residual) ──────────────────────────
 * `submitEvidence` is permissionless, and on a public chain an evidence id (the
 * Supabase UUID) is visible in the mempool before it confirms.  An adversary can
 * therefore front-run a submission with the same id but a different content hash,
 * reverting the victim ("already submitted") and binding the id to junk content.
 * This is bounded, not catastrophic: (a) the off-chain `audit-content-hash` job
 * flags any on-chain hash that does not match the canonical payload, so the junk
 * is detected; (b) UUIDs are free, so the victim simply re-mints and resubmits;
 * (c) nothing enters the public archive without passing peer review.  Taxonomy
 * proposals are additionally peer-gated and any squatted-but-unratifiable node
 * is freed by the permissionless `lapseProposal` after `PROPOSAL_WINDOW`.  A
 * commit-reveal submission scheme would close the window entirely at the cost of
 * a second transaction per submission; it is deliberately omitted here.
 *
 * ── Two-step ownership ──────────────────────────────────────────────────────
 * `proposeOwner` → `acceptOwnership` (or `cancelOwnershipTransfer`); or
 * `renounceOwnership` to drop the owner entirely.
 *
 * ── Peer-floor invariant ────────────────────────────────────────────────────
 * `_removePeer` requires `activePeerCount > 1`.
 */
contract EvidenceConsensus {

    // ── State enum ───────────────────────────────────────────────────────────

    enum EvidenceState {
        None,        // 0 — binding does not exist
        Submitted,   // 1 — awaiting review votes
        Canon,       // 2 — canonized by peer consensus
        Expelled,    // 3 — rejected by peer consensus
        Lapsed,      // 4 — timed out without reaching threshold
        Contested,   // 5 — canon binding under active challenge
        Deprecated,  // 6 — removed by challenge consensus
        Reaffirmed,  // 7 — survived challenge, re-confirmed as canon
        Queued       // 8 — parked behind a full active-review set; not yet in review
    }

    // ── Taxonomy enums ───────────────────────────────────────────────────────

    enum NodeKind  { Pillar, Topic }                     // 0, 1
    enum NodeState { None, Proposed, Ratified, Retired } // 0, 1, 2, 3 — None is the default

    // ── Storage ──────────────────────────────────────────────────────────────

    address public owner;
    address public pendingOwner;   // two-step ownership transfer
    address public genesis;        // first peer; set at deployment
    uint256 public immutable seedPhaseK;
    bool    public paused;

    // ── EIP-712 vote-by-signature ─────────────────────────────────────────────
    //
    // Every review / challenge vote is authorised by an on-chain-recovered EIP-712
    // signature, so a vote can never exist without the peer's signature.  The
    // submitter (msg.sender) may be a relayer; attribution is the recovered
    // signer, which must be an active peer.
    bytes32 private immutable _DOMAIN_SEPARATOR;
    // `round` binds a signature to the binding's CURRENT review/challenge round,
    // so a signature can never be replayed on a later re-filed round of the same
    // binding (which would re-count a peer's verdict without fresh consent).
    bytes32 private constant _VOTE_TYPEHASH =
        keccak256("Vote(bytes32 bindingId,uint8 phase,bool support,uint32 round,bytes32 noteHash)");
    // The single Vote typehash authorises every on-chain peer act, keyed by
    // `phase`: 0 = review, 1 = challenge, 2 = taxonomy (propose/endorse), 3 =
    // taxonomy retire (motion/vote), 4 = force-renounce (motion/vote). For
    // node-scoped phases (2,3) `bindingId` carries the node id and `round` the
    // node's propose/retire round; force-renounce has no subject, so it signs a
    // fixed sentinel id and the global forceRenounceRound. A `noteHash` commits
    // an optional off-chain deliberation note (ZeroHash when empty).
    bytes32 private constant _FORCE_RENOUNCE_ID = keccak256("force-renounce");
    uint8   private constant _PHASE_TAXONOMY      = 2;
    uint8   private constant _PHASE_RETIRE        = 3;
    uint8   private constant _PHASE_FORCERENOUNCE = 4;

    // ── Peer registry ────────────────────────────────────────────────────────

    address[] private _peerList;
    mapping(address => uint256) private peerIndex;        // 1-based
    mapping(address => bool)    public isPeer;            // sticky
    mapping(address => bool)    public isActivePeer;
    mapping(address => string)  public peerHandle;
    uint256 public activePeerCount;

    // Per-peer liveness clock for automatic garbage collection.  Set on
    // admission and refreshed by every consensus VOTE (review/challenge) and by
    // an explicit heartbeat(); a peer idle past INACTIVITY_WINDOW can be pruned
    // by anyone, keeping the activePeerCount denominator (and thus every
    // threshold) honest so a stale network can still reach consensus.
    mapping(address => uint48) public lastActive;

    // ── Peer governance (nominee + revocation flows) ──────────────────────────
    //
    // The nominee (admission) and revocation (removal) flows live in the separate
    // {PeerGovernance} contract to keep the core under EIP-170 once the EIP-712
    // vote-by-signature machinery was added.  That contract mutates the peer set
    // here through `gAddPeer` / `gRemovePeer`, gated on `onlyGovernance`.  Wired
    // once after deploy via `setGovernance`.
    address public governance;

    // ── Force-renounce state (peer eviction of a captured owner) ──────────────
    //
    // The owner's only powers are pause and seed-phase addPeer, and
    // renounceOwnership is gated on !paused — so a malicious/compromised owner
    // could pause forever and brick the network with no peer recourse.  This
    // motion closes that gap: a 2/3 peer supermajority (retireThreshold) strips
    // the owner entirely and unpauses, the same BFT bar used to destroy canon
    // governance.  Global (one motion at a time), round-isolated like revoke.
    bool   public   forceRenounceActive;
    uint32 public   forceRenounceVotes;
    uint48 internal forceRenounceMotionAt; // internal bookkeeping (stale-restart clock)
    uint32 public   forceRenounceRound;    // vote-isolation round (read by the signer to bind a PeerVote)
    mapping(uint32 => mapping(address => bool)) private _votedForceRenounce;

    // ── Challenge rate limiting ──────────────────────────────────────────────

    mapping(address => uint48) public lastChallengeAt;

    // ── Evidence records ─────────────────────────────────────────────────────
    //
    // The evidence is the canonical content; its lifecycle lives on the bindings.

    struct Evidence {
        bool    exists;
        uint8   tier;             // 1 | 2 | 3
        address submitter;
        uint48  submittedAt;
        uint32  bindingCount;     // number of (evidence, topic) bindings
        bytes32 contentHash;      // keccak of canonical off-chain payload (content only)
    }

    // Non-public: the explicit getEvidence() wrapper is the read surface, so an
    // auto-generated getter would be redundant bytecode.
    mapping(bytes32 => Evidence) private evidences;

    // An evidence id reserved by a still-pending founding bundle, so a
    // concurrent submitEvidence / second bundle cannot register (and a later
    // materialization cannot overwrite) the same record before the bundle
    // ratifies or lapses.
    mapping(bytes32 => bool) public evidenceReserved;

    // ── Binding records — the voting unit ─────────────────────────────────────

    struct Binding {
        EvidenceState state;
        bytes32 evidenceId;
        bytes32 topicId;
        uint32  approveCount;
        uint32  rejectCount;
        uint32  challengeVotes;
        uint32  defenseVotes;
        uint48  submittedAt;
        uint48  canonAt;
        uint48  challengedAt;
        uint32  challengeRound;   // bumped each time the binding is (re-)contested
        uint32  reviewRound;      // bumped each time a lapsed binding is re-filed for review
        uint32  peerSnapshot;     // activePeerCount snapshotted at review-open: the canonize
                                  // and review-expel denominator, frozen so a fixed approve
                                  // count canonizes regardless of membership churn during the
                                  // review window.  Challenge resolution uses the LIVE count.
    }

    // Non-public: read via getBinding(); auto-getter would be redundant bytecode.
    mapping(bytes32 => Binding) private bindings;

    // ── Submission queue ──────────────────────────────────────────────────────
    //
    // Open submission scales, but peers can only review so much at once.  The
    // ACTIVE review set is bounded at a fixed reviewCapacity() = REVIEW_CAPACITY
    // (a shared batch the whole network reviews in the same order); submissions
    // over that bound park in the Queued state (their review clock has not
    // started) instead of flooding the queue.  This
    // global bound plus the per-address SUBMIT_COOLDOWN replaces the old
    // per-submitter outstanding cap: a single identity can no longer flood the
    // ACTIVE set regardless of how much it queues.  A public boost raises
    // queuePriority so the keeper promotes the most important evidence first;
    // promotion is permissionless so the queue always drains even if the keeper
    // is down.  Self-healing: activeReviewCount drops as bindings resolve, freeing
    // slots for the next promotion.  (queuePriority is projected off-chain from
    // QueueBoosted events, so no on-chain getter is needed.)
    uint256 public activeReviewCount;                            // non-founding bindings currently in Submitted
    mapping(address => uint48) private lastSubmitAt;             // per-address submit cooldown clock
    mapping(address => uint48) public  lastBoostAt;              // per-address public-boost cooldown clock
    mapping(bytes32 => uint32) private queuePriority;            // public boost tally per binding
    mapping(bytes32 => mapping(address => bool)) private _boosted; // one boost per address per binding

    // Same idea for taxonomy proposals: cap each peer's OUTSTANDING (still
    // Proposed) pillar/topic proposals so a single peer can't flood the proposal
    // queue (each proposal reserves an evidence id and grows _proposedNodeIds).
    // The on-chain analogue of the off-chain tax_insert: throttle, enforced even
    // when a peer calls the contract directly.  Self-healing: the count drops as
    // proposals ratify or lapse.
    mapping(address => uint32) public pendingProposals;

    // ── Taxonomy registry ────────────────────────────────────────────────────

    struct TaxonomyNode {
        NodeKind  kind;
        NodeState state;
        bytes32   parent;        // parent pillar id for a topic; 0 for a pillar
        bytes32   metaHash;      // keccak of canonical off-chain metadata JSON
        address   proposedBy;
        uint48    proposedAt;
        uint32    endorsements;
    }

    // Non-public: read via getTaxonomyNode(); auto-getter would be redundant.
    mapping(bytes32 => TaxonomyNode) private taxonomyNodes;
    bytes32[] private _pillarIds;                          // ratified pillars
    mapping(bytes32 => bytes32[]) private _pillarTopics;   // ratified topics per pillar
    bytes32[] private _proposedNodeIds;                    // pending proposals
    mapping(bytes32 => uint256) private proposedIndex;     // 1-based
    mapping(bytes32 => uint32)  public nodeRound;          // bumped per (re-)proposal
    // _endorsedNode[id][round][peer] — fresh eligibility each proposal round.
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) private _endorsedNode;

    // ── Taxonomy retirement ──────────────────────────────────────────────────
    //
    // A ratified pillar/topic is never deleted (the log is immutable), but a
    // strong supermajority of peers can RETIRE a TOPIC to correct an erroneous
    // or abusive node.  Retirement mirrors the revocation motion: a peer motions,
    // peers vote, and at `retireThreshold` (ceil(2n/3)) the topic flips to
    // Retired and is dropped from the public topic list.  Pillars are never
    // retired directly — a pillar retires automatically together with its LAST
    // topic, so it can never sit ratified with zero topics (no empty pillars).
    mapping(bytes32 => bool)   public retireActive;
    mapping(bytes32 => uint32) public retireVotes;
    mapping(bytes32 => uint48) public retireMotionAt;      // motion open time (for expiry)
    mapping(bytes32 => uint32) public retireRound;         // bumped per motion; isolates votes
    // _votedRetire[id][round][voter] — fresh eligibility each motion.
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) private _votedRetire;

    // ── Founding bundle ──────────────────────────────────────────────────────
    //
    // A taxonomy node is never empty: every pillar is proposed together with its
    // first topic AND a first piece of evidence, and every topic is proposed
    // together with a first piece of evidence.  The whole bundle rides on a
    // single endorsement gate — when the proposed node reaches bundleThreshold,
    // the node ratifies, the founding topic (for a pillar) ratifies, and the
    // founding evidence is registered and its (evidence, topic) binding is
    // canonized atomically.
    struct FoundingBundle {
        bool    exists;
        bytes32 topicId;        // pillar bundle: the founding child topic; topic bundle: 0
        bytes32 topicMetaHash;  // pillar bundle: founding topic metadata; topic bundle: 0
        bytes32 evidenceId;     // the founding evidence
        uint8   tier;
        bytes32 contentHash;
    }

    // Keyed by the PROPOSED node id (pillarId for a pillar bundle, topicId for a
    // topic bundle).  Cleared once the bundle materializes at ratification or is
    // garbage-collected at lapse.
    mapping(bytes32 => FoundingBundle) public foundingBundle;

    // A founding child topic reserved by a still-pending pillar bundle, so a
    // second pillar bundle or a standalone topic can't claim the same id before
    // the pillar ratifies and materializes it.
    mapping(bytes32 => bool) public topicReserved;

    // Per-binding, per-review-round eligibility — _votedReview[bid][round][voter].
    // Review-round-scoped so a lapsed binding that is re-filed gets fresh votes.
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) private _votedReview;
    // Per-binding, per-round challenge eligibility — _votedChallenge[bid][round][voter].
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) private _votedChallenge;

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant PENDING_WINDOW       = 30 days;
    uint256 public constant CHALLENGE_WINDOW     = 21 days;
    uint256 public constant CHALLENGE_COOLDOWN   = 7 days;  // per-peer, between opening challenges
    uint256 public constant RECHALLENGE_COOLDOWN = 30 days; // per-binding, between successive challenges
    uint256 public constant PROPOSAL_WINDOW      = 30 days; // taxonomy proposal expiry
    uint256 public constant REVOKE_WINDOW        = 14 days; // revocation motion expiry
    uint256 public constant MAX_HANDLE_BYTES     = 64;
    uint32  internal constant MAX_PENDING_PROPOSALS      = 8;  // outstanding-proposal cap per peer
    uint256 internal constant INACTIVITY_WINDOW   = 30 days;   // peer idle before it can be pruned
    uint32  internal constant REVIEW_CAPACITY = 3;             // fixed active-review capacity (shared batch)
    uint256 internal constant SUBMIT_COOLDOWN     = 10 minutes; // per-address gap between PUBLIC submissions
    uint256 public   constant BOOST_COOLDOWN      = 10 minutes; // per-address gap between PUBLIC boosts

    // ── Events ───────────────────────────────────────────────────────────────

    event PeerAdded   (address indexed peer, string handle, uint256 activePeerCount);
    event PeerRemoved (address indexed peer, uint256 activePeerCount);

    event PillarProposed     (bytes32 indexed id, bytes32 metaHash, address indexed proposedBy, uint256 threshold);
    event TopicProposed      (bytes32 indexed id, bytes32 indexed parent, bytes32 metaHash, address indexed proposedBy, uint256 threshold);
    event NodeEndorsed       (bytes32 indexed id, address indexed endorser, uint32 endorsements, uint256 threshold);
    event ProposalLapsed     (bytes32 indexed id);
    event PillarRatified     (bytes32 indexed id, bytes32 metaHash);
    event TopicRatified      (bytes32 indexed id, bytes32 indexed parent, bytes32 metaHash);

    event NodeRetireMotioned (bytes32 indexed id, address indexed by, uint256 threshold);
    event NodeRetireVoteCast (bytes32 indexed id, address indexed voter, uint32 votes, uint256 threshold);
    event NodeRetireCancelled(bytes32 indexed id);
    event NodeRetired        (bytes32 indexed id, uint8 kind, bytes32 indexed parent);

    // Evidence registration is emitted once per content id; bindings carry the
    // lifecycle.  All binding events carry (evidenceId, topicId) so an off-chain
    // indexer can resolve both the canonical record and the taxonomy node.
    event EvidenceSubmitted  (bytes32 indexed id, uint8 tier, address indexed submitter, bytes32 contentHash);
    event BindingSubmitted   (bytes32 indexed bindingId, bytes32 indexed id, bytes32 indexed topicId, uint8 tier, address submitter);
    event BindingQueued      (bytes32 indexed bindingId, bytes32 indexed id, bytes32 indexed topicId, uint8 tier, address submitter);
    event QueueBoosted       (bytes32 indexed bindingId, address indexed supporter, uint32 queuePriority);
    event ReviewVoteCast     (bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, address indexed voter, bool approve, uint32 approveCount, uint32 rejectCount, bytes sig);
    event BindingCanonized   (bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, uint48 canonAt, uint32 approveCount);
    event BindingExpelled    (bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, uint32 rejectCount);
    event BindingLapsed      (bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId);

    event ChallengeOpened    (bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, address indexed challenger, uint48 challengedAt);
    event ChallengeVoteCast  (bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, address indexed voter, bool supportChallenge, uint32 challengeVotes, uint32 defenseVotes, bytes sig);
    event BindingDeprecated  (bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, uint32 challengeVotes);
    event BindingReaffirmed  (bytes32 indexed bindingId, bytes32 indexed id, bytes32 topicId, uint32 defenseVotes);

    event Paused                    (address indexed by);
    event Unpaused                  (address indexed by);
    event OwnershipProposed         (address indexed previousOwner, address indexed proposedOwner);
    event OwnershipTransferred      (address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferCancelled(address indexed by);

    event ForceRenounceMotioned (address indexed by, uint256 threshold);
    event ForceRenounceVoteCast (address indexed voter, uint32 votes, uint256 threshold);

    // ── Constructor ──────────────────────────────────────────────────────────

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

        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("EvidenceConsensus")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
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

    modifier onlyGovernance() {
        require(msg.sender == governance, "not governance");
        _;
    }

    // ── Owner emergency controls ─────────────────────────────────────────────
    //
    // All owner powers are seed-phase or emergency only; `renounceOwnership`
    // removes them permanently once the network has opened.

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

    /// @notice Drop the owner entirely — no more pause/seed powers, ever.
    /// Only callable once the seed phase is complete and the contract is live,
    /// so the network can never be left bricked (paused / un-seedable).
    function renounceOwnership() external onlyOwner {
        require(!paused, "paused");
        require(activePeerCount >= seedPhaseK, "seed phase not complete");
        address previous = owner;
        owner        = address(0);
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, address(0));
    }

    // ── Force-renounce: peer supermajority evicts the owner ───────────────────
    //
    // These deliberately have NO whenNotPaused guard — the whole point is to act
    // when a captured owner has paused the contract.

    /// @notice Open a motion for peers to strip the owner entirely (and unpause).
    /// The escape hatch against an owner that pauses forever.  Motioner is vote #1.
    function motionForceRenounce(bytes32 noteHash, bytes calldata sig) external onlyActivePeer {
        require(owner != address(0), "no owner");
        // A live motion blocks a new one; a stale motion (past the window without
        // reaching 2/3) is simply restarted with a fresh round — so a single peer
        // can't permanently block force-renounce by opening one that never passes.
        require(
            !forceRenounceActive ||
            block.timestamp > uint256(forceRenounceMotionAt) + PROPOSAL_WINDOW,
            "force-renounce active"
        );

        // A motion opens the new round AND casts vote #1, so it signs round+1.
        uint32 round = ++forceRenounceRound;
        require(_recoverVoter(_FORCE_RENOUNCE_ID, _PHASE_FORCERENOUNCE, true, round, noteHash, sig) == msg.sender, "bad sig");
        forceRenounceActive   = true;
        forceRenounceMotionAt = uint48(block.timestamp);
        forceRenounceVotes    = 1;
        _votedForceRenounce[round][msg.sender] = true;

        uint256 threshold = retireThreshold();
        emit ForceRenounceMotioned(msg.sender, threshold);
        emit ForceRenounceVoteCast(msg.sender, 1, threshold);

        _checkForceRenounce(threshold);
    }

    function voteForceRenounce(bytes32 noteHash, bytes calldata sig) external onlyActivePeer {
        require(forceRenounceActive, "no force-renounce active");
        uint32 round = forceRenounceRound;
        require(_recoverVoter(_FORCE_RENOUNCE_ID, _PHASE_FORCERENOUNCE, true, round, noteHash, sig) == msg.sender, "bad sig");
        require(!_votedForceRenounce[round][msg.sender], "already voted");

        _votedForceRenounce[round][msg.sender] = true;
        forceRenounceVotes++;

        uint256 threshold = retireThreshold();
        emit ForceRenounceVoteCast(msg.sender, forceRenounceVotes, threshold);

        _checkForceRenounce(threshold);
    }

    function _checkForceRenounce(uint256 threshold) internal {
        if (forceRenounceVotes < threshold) return;
        forceRenounceActive = false;
        forceRenounceVotes  = 0;
        address previous = owner;
        owner        = address(0);
        pendingOwner = address(0);
        if (paused) { paused = false; emit Unpaused(msg.sender); }
        emit OwnershipTransferred(previous, address(0));
    }

    // ── Peer management ──────────────────────────────────────────────────────
    //
    // The owner may only seed peers while the network is in its seed phase.
    // After that, membership changes go through the nominee / revocation votes —
    // there is no owner override.  Genesis peers are seeded in the constructor.

    function addPeer(address peer, string calldata handle) external onlyOwner {
        require(activePeerCount < seedPhaseK, "seed phase over");
        _addPeer(peer, handle);
    }

    // ── Peer-governance wiring ────────────────────────────────────────────────
    //
    // The nominee / revocation flows live in {PeerGovernance}; it is the only
    // contract authorized to add/remove peers post-seed-phase (besides inactivity
    // GC), wired once by the owner via the one-shot `setGovernance`.

    /// @notice One-shot setter linking the PeerGovernance contract.  Callable only
    /// while unset, so governance can never be re-pointed once established.
    function setGovernance(address g) external onlyOwner {
        require(governance == address(0), "governance set");
        governance = g;
    }

    function gAddPeer(address peer, string calldata handle) external onlyGovernance {
        _addPeer(peer, handle);
    }

    function gRemovePeer(address peer) external onlyGovernance {
        _removePeer(peer);
    }

    function _addPeer(address peer, string memory handle) internal {
        require(peer != address(0), "zero address");
        require(!isActivePeer[peer], "already active");
        require(bytes(handle).length <= MAX_HANDLE_BYTES, "handle too long");

        isPeer[peer]       = true;
        isActivePeer[peer] = true;
        peerHandle[peer]   = handle;
        lastActive[peer]   = uint48(block.timestamp);

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

        emit PeerRemoved(peer, activePeerCount);
    }

    function peerList() external view returns (address[] memory) {
        return _peerList;
    }

    // ── Peer liveness / garbage collection ───────────────────────────────────

    /// @notice Refresh the caller's liveness clock without casting a vote, for a
    /// peer who is present and willing but has nothing to review right now.
    function heartbeat() external onlyActivePeer whenNotPaused {
        lastActive[msg.sender] = uint48(block.timestamp);
    }

    /// @notice Permissionless removal of a peer idle past INACTIVITY_WINDOW.
    /// Inactivity is objective on-chain (lastActive), so no peer vote is needed —
    /// unlike the subjective misbehaviour revoke.  Never drops the active set
    /// below the seed-phase floor, so GC can't strand or capture the network.
    /// Emits PeerRemoved (via _removePeer), the same projection as any departure.
    function pruneInactivePeer(address peer) external whenNotPaused {
        require(activePeerCount > seedPhaseK, "at peer floor");
        require(isActivePeer[peer], "not active peer");
        require(block.timestamp > uint256(lastActive[peer]) + INACTIVITY_WINDOW, "still active");
        _removePeer(peer);
    }

    // ── Threshold functions ──────────────────────────────────────────────────

    /// @notice Canonization is a TRUE MAJORITY of peers (tier1 60 / tier2 55 /
    /// tier3 51 %), so "Canon" reflects majority consensus, never a large
    /// minority.  The `*At` helper takes an explicit n so a binding can be judged
    /// against the peer count snapshotted when it entered review/challenge,
    /// keeping the outcome order-independent across membership changes.
    function _canonizeThresholdAt(uint8 tier, uint256 n) internal pure returns (uint256) {
        uint256 pct;
        if (tier == 1) pct = 60;
        else if (tier == 2) pct = 55;
        else pct = 51;
        uint256 raw = (n * pct + 99) / 100;
        return raw < 1 ? 1 : raw;
    }

    function canonizeThreshold(uint8 tier) public view returns (uint256) {
        return _canonizeThresholdAt(tier, activePeerCount);
    }

    function _expelThresholdAt(uint256 n) internal pure returns (uint256) {
        uint256 raw = (n * 25 + 99) / 100;
        return raw < 1 ? 1 : raw;
    }

    function expelThreshold() public view returns (uint256) {
        return _expelThresholdAt(activePeerCount);
    }

    function _deprecateThresholdAt(uint8 tier, uint256 n) internal pure returns (uint256) {
        uint256 pct;
        if (tier == 1) pct = 65;
        else if (tier == 2) pct = 60;
        else pct = 55;
        uint256 raw = (n * pct + 99) / 100;
        return raw < 1 ? 1 : raw;
    }

    function deprecateThreshold(uint8 tier) public view returns (uint256) {
        return _deprecateThresholdAt(tier, activePeerCount);
    }

    // Admission (nomineeThreshold) and revocation (revokeThreshold) gates live in
    // the {PeerGovernance} contract alongside the flows that use them.

    /// @notice Gate to ratify a taxonomy node — a STRICT MAJORITY floor(n/2)+1,
    /// decoupled from the 1/3+1 peer-admission gate (which stays load-bearing for
    /// the capture boundary).  Creating canon taxonomy now needs a majority, so
    /// it is no longer far cheaper than retiring it (ceil 2n/3): the create/retire
    /// gap narrows from 1/3→2/3 to 1/2→2/3, and a sub-majority faction can no
    /// longer spawn nodes that a supermajority must then clean up.
    function taxonomyThreshold() public view returns (uint256) {
        return activePeerCount / 2 + 1; // strict majority; ≥ 1 for all n ≥ 0
    }

    /// @notice Gate to retire a ratified taxonomy node — ceil(2n/3), a strong
    /// supermajority.  Retiring canon taxonomy must be much harder than ratifying
    /// it, and the 2/3 bar sits above the capture line, so a sub-1/3 coalition can
    /// neither create nor destroy nodes.
    function retireThreshold() public view returns (uint256) {
        uint256 raw = (activePeerCount * 2 + 2) / 3; // ceil(2n / 3)
        return raw < 1 ? 1 : raw;
    }

    /// @notice Effective gate to ratify a founding bundle: at least the taxonomy
    /// threshold AND at least the tier's canonize threshold, so founding evidence
    /// is never canonized on a cheaper vote than the normal review path.
    function bundleThreshold(uint8 tier) public view returns (uint256) {
        uint256 t = taxonomyThreshold();
        uint256 c = canonizeThreshold(tier);
        return t > c ? t : c;
    }

    // ── Peer governance (nominee + revocation flows) ──────────────────────────
    //
    // nominatePeer / endorseNominee / lapseNominee / nomineeList / hasEndorsed and
    // motionRevoke / voteRevoke / cancelStaleRevocation / hasVotedRevoke, plus
    // nominationsOpen / nomineeThreshold / revokeThreshold, live in the
    // {PeerGovernance} contract.  It admits/removes peers here through the
    // governance-gated gAddPeer / gRemovePeer.

    // ── Taxonomy flow ────────────────────────────────────────────────────────

    /**
     * @notice Propose a new pillar bundled with its founding topic and a first
     * piece of evidence.  A pillar is never empty: ratifying it ratifies the
     * founding topic and canonizes the founding evidence in the same step.
     */
    function proposePillar(
        bytes32 id,
        bytes32 metaHash,
        bytes32 topicId,
        bytes32 topicMetaHash,
        bytes32 evidenceId,
        uint8   tier,
        bytes32 contentHash,
        bytes32 noteHash,
        bytes calldata sig
    )
        external onlyActivePeer whenNotPaused
    {
        require(id != bytes32(0) && topicId != bytes32(0), "zero id");
        require(id != topicId, "id collision");
        require(metaHash != bytes32(0) && topicMetaHash != bytes32(0), "empty meta hash");
        // The proposer is endorsement #1, so they sign a taxonomy Vote over the
        // pillar id at the round _registerProposal is about to mint (current + 1).
        require(_recoverVoter(id, _PHASE_TAXONOMY, true, nodeRound[id] + 1, noteHash, sig) == msg.sender, "bad sig");
        // The pillar's own id must be free as a node AND not reserved as another
        // pending pillar's founding child topic, mirroring proposeTopic.  Without
        // the topicReserved[id] guard a pillar could register at a reserved topic
        // id and be silently overwritten when that pillar materializes its child.
        require(taxonomyNodes[id].state == NodeState.None && !topicReserved[id], "node exists");
        require(taxonomyNodes[topicId].state == NodeState.None && !topicReserved[topicId], "topic taken");
        _requireFoundingEvidence(evidenceId, tier, contentHash);

        _registerProposal(id, NodeKind.Pillar, bytes32(0), metaHash);
        foundingBundle[id] = FoundingBundle(true, topicId, topicMetaHash, evidenceId, tier, contentHash);
        topicReserved[topicId]      = true;
        evidenceReserved[evidenceId] = true;

        emit PillarProposed(id, metaHash, msg.sender, bundleThreshold(tier));
        emit NodeEndorsed(id, msg.sender, 1, bundleThreshold(tier));
        _checkRatify(id);
    }

    /**
     * @notice Propose a new topic under a ratified pillar, bundled with a first
     * piece of evidence.  A topic is never empty: ratifying it canonizes the
     * founding evidence in the same step.
     */
    function proposeTopic(
        bytes32 id,
        bytes32 parentPillar,
        bytes32 metaHash,
        bytes32 evidenceId,
        uint8   tier,
        bytes32 contentHash,
        bytes32 noteHash,
        bytes calldata sig
    )
        external onlyActivePeer whenNotPaused
    {
        require(id != bytes32(0), "zero id");
        require(metaHash != bytes32(0), "empty meta hash");
        require(taxonomyNodes[id].state == NodeState.None && !topicReserved[id], "topic taken");
        // Proposer is endorsement #1 — sign a taxonomy Vote over the topic id at
        // the round _registerProposal is about to mint (current + 1).
        require(_recoverVoter(id, _PHASE_TAXONOMY, true, nodeRound[id] + 1, noteHash, sig) == msg.sender, "bad sig");

        TaxonomyNode storage parent = taxonomyNodes[parentPillar];
        require(parent.state == NodeState.Ratified && parent.kind == NodeKind.Pillar, "bad parent");
        _requireFoundingEvidence(evidenceId, tier, contentHash);

        _registerProposal(id, NodeKind.Topic, parentPillar, metaHash);
        foundingBundle[id] = FoundingBundle(true, bytes32(0), bytes32(0), evidenceId, tier, contentHash);
        evidenceReserved[evidenceId] = true;

        emit TopicProposed(id, parentPillar, metaHash, msg.sender, bundleThreshold(tier));
        emit NodeEndorsed(id, msg.sender, 1, bundleThreshold(tier));
        _checkRatify(id);
    }

    function _requireFoundingEvidence(bytes32 evidenceId, uint8 tier, bytes32 contentHash) internal view {
        require(evidenceId != bytes32(0), "zero evidence id");
        require(tier >= 1 && tier <= 3, "invalid tier");
        require(contentHash != bytes32(0), "empty content hash");
        require(!evidences[evidenceId].exists && !evidenceReserved[evidenceId], "evidence taken");
    }

    function endorseNode(bytes32 id, bytes32 noteHash, bytes calldata sig)
        external onlyActivePeer whenNotPaused
    {
        TaxonomyNode storage n = taxonomyNodes[id];
        require(n.state == NodeState.Proposed, "not proposed");
        uint32 round = nodeRound[id];
        require(_recoverVoter(id, _PHASE_TAXONOMY, true, round, noteHash, sig) == msg.sender, "bad sig");
        require(!_endorsedNode[id][round][msg.sender], "already endorsed");

        _endorsedNode[id][round][msg.sender] = true;
        n.endorsements++;

        emit NodeEndorsed(id, msg.sender, n.endorsements, bundleThreshold(foundingBundle[id].tier));
        _checkRatify(id);
    }

    function _registerProposal(bytes32 id, NodeKind kind, bytes32 parent, bytes32 metaHash) internal {
        require(pendingProposals[msg.sender] < MAX_PENDING_PROPOSALS, "proposal cap reached");
        pendingProposals[msg.sender]++;

        uint32 round = ++nodeRound[id];
        taxonomyNodes[id] = TaxonomyNode({
            kind:         kind,
            state:        NodeState.Proposed,
            parent:       parent,
            metaHash:     metaHash,
            proposedBy:   msg.sender,
            proposedAt:   uint48(block.timestamp),
            endorsements: 1
        });
        _endorsedNode[id][round][msg.sender] = true;

        _proposedNodeIds.push(id);
        proposedIndex[id] = _proposedNodeIds.length; // 1-based
    }

    function _checkRatify(bytes32 id) internal {
        TaxonomyNode storage n = taxonomyNodes[id];
        FoundingBundle memory fb = foundingBundle[id];
        if (n.endorsements < bundleThreshold(fb.tier)) return;

        // A topic ratifies only while its parent pillar is still ratified.  If the
        // pillar was retired while this proposal was in flight, do NOT ratify: that
        // would orphan a live topic (and canon founding evidence) under a retired
        // pillar and let a simple-majority proposal partially undo a 2/3 retirement.
        // Leave it Proposed so lapseProposal garbage-collects it after the window.
        if (n.kind == NodeKind.Topic && taxonomyNodes[n.parent].state != NodeState.Ratified) return;

        n.state = NodeState.Ratified;
        pendingProposals[n.proposedBy]--;
        _removeProposal(id);
        delete foundingBundle[id];
        evidenceReserved[fb.evidenceId] = false;

        if (n.kind == NodeKind.Pillar) {
            _pillarIds.push(id);
            emit PillarRatified(id, n.metaHash);

            // Materialize the founding child topic as ratified under this pillar.
            topicReserved[fb.topicId] = false;
            taxonomyNodes[fb.topicId] = TaxonomyNode({
                kind:         NodeKind.Topic,
                state:        NodeState.Ratified,
                parent:       id,
                metaHash:     fb.topicMetaHash,
                proposedBy:   n.proposedBy,
                proposedAt:   n.proposedAt,
                endorsements: n.endorsements
            });
            _pillarTopics[id].push(fb.topicId);
            emit TopicRatified(fb.topicId, id, fb.topicMetaHash);

            _materializeFounding(fb.evidenceId, fb.topicId, fb.tier, fb.contentHash, n.proposedBy, n.endorsements);
        } else {
            _pillarTopics[n.parent].push(id);
            emit TopicRatified(id, n.parent, n.metaHash);

            _materializeFounding(fb.evidenceId, id, fb.tier, fb.contentHash, n.proposedBy, n.endorsements);
        }
    }

    /// @notice Garbage-collect a taxonomy proposal that never reached its gate,
    /// freeing the node id, the reserved founding topic id, and the reserved
    /// founding evidence id so they can be proposed again.  Permissionless after
    /// the window; the next proposal of the same id gets a fresh endorsement
    /// round (so prior endorsers can endorse again).
    function lapseProposal(bytes32 id) external whenNotPaused {
        TaxonomyNode storage n = taxonomyNodes[id];
        require(n.state == NodeState.Proposed, "not proposed");
        require(block.timestamp > uint256(n.proposedAt) + PROPOSAL_WINDOW, "window still open");

        FoundingBundle memory fb = foundingBundle[id];
        NodeKind kind     = n.kind;
        address  proposer = n.proposedBy;

        pendingProposals[proposer]--;
        _removeProposal(id);
        delete foundingBundle[id];
        delete taxonomyNodes[id];
        evidenceReserved[fb.evidenceId] = false;
        if (kind == NodeKind.Pillar) topicReserved[fb.topicId] = false;

        emit ProposalLapsed(id);
    }

    /// @notice Register the founding evidence and open its (evidence, topic)
    /// binding straight into Canon — the taxonomy endorsement is the consensus.
    function _materializeFounding(
        bytes32 evidenceId,
        bytes32 topicId,
        uint8   tier,
        bytes32 contentHash,
        address submitter,
        uint32  endorsements
    ) internal {
        require(!evidences[evidenceId].exists, "evidence exists");
        evidences[evidenceId] = Evidence({
            exists:       true,
            tier:         tier,
            submitter:    submitter,
            submittedAt:  uint48(block.timestamp),
            bindingCount: 1,
            contentHash:  contentHash
        });
        emit EvidenceSubmitted(evidenceId, tier, submitter, contentHash);

        bytes32 bid = bindingId(evidenceId, topicId);
        bindings[bid] = Binding({
            state:           EvidenceState.Canon,
            evidenceId:      evidenceId,
            topicId:         topicId,
            approveCount:    endorsements,
            rejectCount:     0,
            challengeVotes:  0,
            defenseVotes:    0,
            submittedAt:     uint48(block.timestamp),
            canonAt:         uint48(block.timestamp),
            challengedAt:    0,
            challengeRound:  0,
            reviewRound:     0,
            peerSnapshot:    uint32(activePeerCount)
        });

        emit BindingSubmitted(bid, evidenceId, topicId, tier, submitter);
        emit BindingCanonized(bid, evidenceId, topicId, uint48(block.timestamp), endorsements);
    }

    function _removeProposal(bytes32 id) internal {
        uint256 idx = proposedIndex[id];
        if (idx == 0) return;
        uint256 lastIdx = _proposedNodeIds.length;
        if (idx != lastIdx) {
            bytes32 moved = _proposedNodeIds[lastIdx - 1];
            _proposedNodeIds[idx - 1] = moved;
            proposedIndex[moved]      = idx;
        }
        _proposedNodeIds.pop();
        proposedIndex[id] = 0;
    }

    // ── Taxonomy retirement ──────────────────────────────────────────────────

    /// @notice Open a motion to retire a ratified TOPIC.  Pillars are not retired
    /// directly: a pillar retires automatically together with its last topic, so
    /// it can never sit ratified with zero topics.  The motioner counts as
    /// retire-vote #1.
    function motionRetireNode(bytes32 id, bytes32 noteHash, bytes calldata sig)
        external onlyActivePeer whenNotPaused
    {
        TaxonomyNode storage n = taxonomyNodes[id];
        require(n.state == NodeState.Ratified, "not ratified");
        require(n.kind == NodeKind.Topic, "pillars auto-retire");
        require(!retireActive[id], "retire already active");

        // A motion opens the new round AND casts retire vote #1, so it signs round+1.
        uint32 round = ++retireRound[id];
        require(_recoverVoter(id, _PHASE_RETIRE, true, round, noteHash, sig) == msg.sender, "bad sig");
        retireActive[id]                 = true;
        retireMotionAt[id]               = uint48(block.timestamp);
        retireVotes[id]                  = 1;
        _votedRetire[id][round][msg.sender] = true;

        uint256 threshold = retireThreshold();
        emit NodeRetireMotioned(id, msg.sender, threshold);
        emit NodeRetireVoteCast(id, msg.sender, 1, threshold);

        _checkRetire(id, threshold);
    }

    function voteRetireNode(bytes32 id, bytes32 noteHash, bytes calldata sig)
        external onlyActivePeer whenNotPaused
    {
        require(retireActive[id], "no retire active");
        uint32 round = retireRound[id];
        require(_recoverVoter(id, _PHASE_RETIRE, true, round, noteHash, sig) == msg.sender, "bad sig");
        require(!_votedRetire[id][round][msg.sender], "already voted");

        _votedRetire[id][round][msg.sender] = true;
        retireVotes[id]++;

        uint256 threshold = retireThreshold();
        emit NodeRetireVoteCast(id, msg.sender, retireVotes[id], threshold);

        _checkRetire(id, threshold);
    }

    /// @notice Clear a stale retire motion that never reached its supermajority.
    /// Permissionless after the window; a fresh motion starts a new round.
    function cancelStaleRetire(bytes32 id) external whenNotPaused {
        require(retireActive[id], "no retire active");
        require(block.timestamp > uint256(retireMotionAt[id]) + PROPOSAL_WINDOW, "window still open");
        retireActive[id] = false;
        retireVotes[id]  = 0;
        emit NodeRetireCancelled(id);
    }

    function _checkRetire(bytes32 id, uint256 threshold) internal {
        if (retireVotes[id] < threshold) return;

        retireActive[id] = false;
        retireVotes[id]  = 0;

        // Only topics are voted to retire (motionRetireNode rejects pillars).
        TaxonomyNode storage n = taxonomyNodes[id];
        n.state = NodeState.Retired;
        bytes32 parent = n.parent;
        _removeFromBytes32Array(_pillarTopics[parent], id);
        emit NodeRetired(id, uint8(NodeKind.Topic), parent);

        // A pillar is never left empty: retiring its last topic retires it too,
        // in the same transaction (no separate pillar vote).
        if (_pillarTopics[parent].length == 0) {
            taxonomyNodes[parent].state = NodeState.Retired;
            _removeFromBytes32Array(_pillarIds, parent);
            emit NodeRetired(parent, uint8(NodeKind.Pillar), bytes32(0));
        }
    }

    /// @notice True iff `voter` has voted on the *current* retire motion for `id`.
    function hasVotedRetire(bytes32 id, address voter) external view returns (bool) {
        return _votedRetire[id][retireRound[id]][voter];
    }

    function _removeFromBytes32Array(bytes32[] storage arr, bytes32 val) internal {
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == val) {
                if (i != len - 1) arr[i] = arr[len - 1];
                arr.pop();
                return;
            }
        }
    }

    // ── Taxonomy views ───────────────────────────────────────────────────────

    function getTaxonomyNode(bytes32 id) external view returns (TaxonomyNode memory) {
        return taxonomyNodes[id];
    }

    /// @notice True iff `who` has endorsed the *current* proposal round of `id`.
    function hasEndorsedNode(bytes32 id, address who) external view returns (bool) {
        return _endorsedNode[id][nodeRound[id]][who];
    }

    function pillarIds() external view returns (bytes32[] memory) {
        return _pillarIds;
    }

    function topicIds(bytes32 pillar) external view returns (bytes32[] memory) {
        return _pillarTopics[pillar];
    }

    function getPillars() external view returns (bytes32[] memory ids, bytes32[] memory metaHashes) {
        uint256 n = _pillarIds.length;
        ids        = new bytes32[](n);
        metaHashes = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 id    = _pillarIds[i];
            ids[i]        = id;
            metaHashes[i] = taxonomyNodes[id].metaHash;
        }
    }

    function getTopics(bytes32 pillar) external view returns (bytes32[] memory ids, bytes32[] memory metaHashes) {
        bytes32[] storage topics = _pillarTopics[pillar];
        uint256 n  = topics.length;
        ids        = new bytes32[](n);
        metaHashes = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 id    = topics[i];
            ids[i]        = id;
            metaHashes[i] = taxonomyNodes[id].metaHash;
        }
    }

    /// @notice Raw list of pending proposal ids; the EvidenceConsensusLens
    /// sidecar joins these to getTaxonomyNode() to rebuild the proposed-node
    /// aggregate off the core's runtime (EIP-170 headroom).
    function proposedNodeIds() external view returns (bytes32[] memory) {
        return _proposedNodeIds;
    }

    // ── Binding id ───────────────────────────────────────────────────────────

    /// @notice Deterministic id for an (evidence, topic) binding.
    function bindingId(bytes32 id, bytes32 topicId) public pure returns (bytes32) {
        return keccak256(abi.encode(id, topicId));
    }

    // ── EIP-712 vote recovery ──────────────────────────────────────────────────

    /// @notice Recover the signer of a Vote(bindingId, phase, support, noteHash)
    /// EIP-712 typed message.  Every review / challenge vote is authorised by the
    /// recovered signer (which the callers gate on `isActivePeer`), so a vote can
    /// never exist without the peer's signature.  phase: 0 = review, 1 = challenge.
    function _recoverVoter(bytes32 bid, uint8 phase, bool support, uint32 round, bytes32 noteHash, bytes calldata sig) internal view returns (address) {
        require(sig.length == 65, "bad sig len");
        bytes32 structHash = keccak256(abi.encode(_VOTE_TYPEHASH, bid, phase, support, round, noteHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, structHash));
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset,32)) v := byte(0, calldataload(add(sig.offset,64))) }
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad sig");
        return signer;
    }

    /// @notice The EIP-712 domain separator, exposed so off-chain signers can
    /// reconstruct the digest.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    // ── Submit evidence + first binding ──────────────────────────────────────

    /**
     * @param id          bytes32-encoded Supabase UUID — links on-chain & off-chain.
     * @param tier        1 (declassified / peer-reviewed), 2 (documented), 3 (testimonial).
     * @param topicId     ratified taxonomy topic the FIRST binding is filed under.
     * @param contentHash keccak256 of the canonical off-chain payload (content only).
     *
     * Open submission: any wallet may submit by signing the transaction itself.
     * `submitter` is recorded as `msg.sender`; peers still gate canonization
     * through review voting.
     */
    function submitEvidence(bytes32 id, uint8 tier, bytes32 topicId, bytes32 contentHash)
        external whenNotPaused
    {
        require(!evidences[id].exists, "already submitted");
        require(!evidenceReserved[id], "evidence reserved");
        require(tier >= 1 && tier <= 3, "invalid tier");
        require(contentHash != bytes32(0), "empty content hash");

        evidences[id] = Evidence({
            exists:       true,
            tier:         tier,
            submitter:    msg.sender,
            submittedAt:  uint48(block.timestamp),
            bindingCount: 0,
            contentHash:  contentHash
        });

        emit EvidenceSubmitted(id, tier, msg.sender, contentHash);
        _openBinding(id, topicId);
    }

    /**
     * @notice File an already-registered evidence under another ratified topic,
     * opening a new independent binding for review.  Each binding votes alone.
     * Open to any wallet — the caller signs the transaction itself.
     */
    function fileBinding(bytes32 id, bytes32 topicId)
        external whenNotPaused
    {
        require(evidences[id].exists, "unknown evidence");
        _openBinding(id, topicId);
    }

    /// @notice Upper bound on bindings in active review at once — a fixed shared
    /// batch the whole network works in the same order; submissions beyond it
    /// park in the queue, where the public boost prioritizes the next promotion.
    function reviewCapacity() public pure returns (uint256) {
        return REVIEW_CAPACITY;
    }

    function _openBinding(bytes32 id, bytes32 topicId) internal {
        require(
            taxonomyNodes[topicId].state == NodeState.Ratified &&
            taxonomyNodes[topicId].kind  == NodeKind.Topic,
            "unratified topic"
        );
        bytes32 bid = bindingId(id, topicId);
        // A binding can be (re-)opened only from None (never filed) or Lapsed
        // (timed out without a verdict).  Expelled/Deprecated are consensus
        // rejections and stay terminal; Canon/Reaffirmed/Contested are live.
        EvidenceState prev = bindings[bid].state;
        require(prev == EvidenceState.None || prev == EvidenceState.Lapsed, "binding active");
        // Throttle only OPEN public submissions; vetted (revocable) peers are
        // exempt.  The global reviewCapacity() bound is the real anti-flood guard
        // (it caps the ACTIVE review set); the cooldown just paces a single
        // anonymous identity's contribution to the queue.
        if (!isActivePeer[msg.sender]) {
            require(
                lastSubmitAt[msg.sender] == 0 ||
                block.timestamp > uint256(lastSubmitAt[msg.sender]) + SUBMIT_COOLDOWN,
                "submit cooldown active"
            );
            lastSubmitAt[msg.sender] = uint48(block.timestamp);
        }

        // Re-filing a lapsed binding bumps its review round so prior voters get a
        // fresh vote; a brand-new binding starts at round 1.
        uint32 round = bindings[bid].reviewRound + 1;

        // Enter review immediately only if the active set has a free slot; else
        // park in the queue with the review clock unset, awaiting promotion.
        bool open = activeReviewCount < reviewCapacity();

        bindings[bid] = Binding({
            state:           open ? EvidenceState.Submitted : EvidenceState.Queued,
            evidenceId:      id,
            topicId:         topicId,
            approveCount:    0,
            rejectCount:     0,
            challengeVotes:  0,
            defenseVotes:    0,
            submittedAt:     open ? uint48(block.timestamp) : 0,
            canonAt:         0,
            challengedAt:    0,
            challengeRound:  0,
            reviewRound:     round,
            peerSnapshot:    open ? uint32(activePeerCount) : 0
        });
        if (prev == EvidenceState.None) evidences[id].bindingCount++;

        uint8 tier = evidences[id].tier;
        if (open) {
            activeReviewCount++;
            emit BindingSubmitted(bid, id, topicId, tier, msg.sender);
        } else {
            emit BindingQueued(bid, id, topicId, tier, msg.sender);
        }
    }

    // ── Review voting ────────────────────────────────────────────────────────

    uint256 public constant MAX_REVIEW_BATCH = 50;

    /// @notice Cast a review vote authorised by the voter's EIP-712 signature.
    /// The submitter (msg.sender) may relay; attribution is the recovered signer,
    /// which must be an active peer.  phase = 0.
    function castReviewVote(bytes32 id, bytes32 topicId, bool approve, bytes32 noteHash, bytes calldata sig)
        external whenNotPaused
    {
        bytes32 bid = bindingId(id, topicId);
        address voter = _recoverVoter(bid, 0, approve, bindings[bid].reviewRound, noteHash, sig);
        require(isActivePeer[voter], "not an active peer");
        _castReviewVote(id, topicId, approve, voter, sig);
    }

    /// @notice Batch many signed votes across bindings in one tx.  Each element
    /// carries its own signature; attribution is per-element by recovered signer.
    function castReviewVoteBatch(
        bytes32[] calldata ids,
        bytes32[] calldata topicIds_,
        bool[]    calldata approves,
        bytes32[] calldata noteHashes,
        bytes[]   calldata sigs
    )
        external whenNotPaused
    {
        uint256 n = ids.length;
        require(
            n == approves.length && n == topicIds_.length &&
            n == noteHashes.length && n == sigs.length,
            "length mismatch"
        );
        require(n > 0, "empty batch");
        require(n <= MAX_REVIEW_BATCH, "batch too large");
        for (uint256 i = 0; i < n; i++) {
            bytes32 bid = bindingId(ids[i], topicIds_[i]);
            address voter = _recoverVoter(bid, 0, approves[i], bindings[bid].reviewRound, noteHashes[i], sigs[i]);
            require(isActivePeer[voter], "not an active peer");
            _castReviewVote(ids[i], topicIds_[i], approves[i], voter, sigs[i]);
        }
    }

    function _castReviewVote(bytes32 id, bytes32 topicId, bool approve, address voter, bytes calldata sig) internal {
        bytes32 bid = bindingId(id, topicId);
        Binding storage b = bindings[bid];
        require(b.state == EvidenceState.Submitted, "not in review");
        require(block.timestamp <= uint256(b.submittedAt) + PENDING_WINDOW, "review window closed");
        require(!_votedReview[bid][b.reviewRound][voter], "already voted");

        _votedReview[bid][b.reviewRound][voter] = true;
        lastActive[voter] = uint48(block.timestamp);

        // The canonization TARGET is judged against the peer count snapshotted when
        // this review round opened, so a fixed approve count canonizes regardless of
        // membership churn.  Early EXPULSION, by contrast, asks whether canon is
        // still reachable by everyone who can CURRENTLY vote, so it is judged against
        // the live electorate (below): a stale, smaller snapshot would otherwise
        // declare "canon impossible" while late-joining peers could still approve,
        // which both breaks order-independence and lets a reject minority pre-empt a
        // would-be canonizing majority once the active set grows mid-window.
        uint256 canonize = _canonizeThresholdAt(evidences[id].tier, b.peerSnapshot);

        if (approve) {
            b.approveCount++;
            emit ReviewVoteCast(bid, id, topicId, voter, true, b.approveCount, b.rejectCount, sig);
            // Early canonization: the moment the high approve bar is met.
            if (b.approveCount >= canonize) {
                b.state   = EvidenceState.Canon;
                b.canonAt = uint48(block.timestamp);
                _clearReviewSlot();
                emit BindingCanonized(bid, id, topicId, b.canonAt, b.approveCount);
            }
        } else {
            b.rejectCount++;
            emit ReviewVoteCast(bid, id, topicId, voter, false, b.approveCount, b.rejectCount, sig);
            // Canonization now arithmetically impossible — even if every peer who has
            // not voted yet approved, approve could not reach `canonize`.  Judged
            // against the LIVE count so canon and "canon impossible" stay mutually
            // exclusive under peer-set GROWTH and the verdict is independent of vote
            // order.  Settle the binding the same way the window-close path does:
            // _settleReview Expels iff the rejections are a consensus rejection
            // (≥ expelThreshold of the review snapshot), else Lapses (re-filable).  In
            // a stable/growing network "canon impossible" already implies the expel
            // quorum, so this Expels exactly as before; only a heavy peer-set SHRINK —
            // where the live set falls below the snapshot canonize target — lapses
            // instead, so membership churn can't terminally expel otherwise-canonizable
            // evidence (it can simply be re-filed against the smaller electorate).
            if (canonize + b.rejectCount > activePeerCount) {
                _settleReview(bid, id, topicId, b);
            }
        }
    }

    /// @notice Free an active-review slot when a non-founding binding leaves the
    /// Submitted state (canonized / expelled / lapsed), so the next queued binding
    /// can be promoted.
    function _clearReviewSlot() internal {
        activeReviewCount--;
    }

    /// @notice Resolve a review that can no longer canonize (canon arithmetically
    /// impossible, or the window closed).  An expel-quorum of rejections
    /// (≥ expelThreshold of the review snapshot) is a consensus rejection → Expelled
    /// (terminal); otherwise the binding merely failed to attract a verdict → Lapsed
    /// (re-filable).  Shared by the early "canon impossible" path and markLapsed so
    /// the expel/lapse rule is defined in exactly one place.
    function _settleReview(bytes32 bid, bytes32 id, bytes32 topicId, Binding storage b) internal {
        _clearReviewSlot();
        if (b.rejectCount >= _expelThresholdAt(b.peerSnapshot)) {
            b.state = EvidenceState.Expelled;
            emit BindingExpelled(bid, id, topicId, b.rejectCount);
        } else {
            b.state = EvidenceState.Lapsed;
            emit BindingLapsed(bid, id, topicId);
        }
    }

    /// @notice Finalize a binding that timed out in review.  Permissionless after the
    /// window; the expel/lapse verdict is decided by _settleReview.
    function markLapsed(bytes32 id, bytes32 topicId) external whenNotPaused {
        bytes32 bid = bindingId(id, topicId);
        Binding storage b = bindings[bid];
        require(b.state == EvidenceState.Submitted, "not pending");
        require(block.timestamp > uint256(b.submittedAt) + PENDING_WINDOW, "window still open");
        _settleReview(bid, id, topicId, b);
    }

    // ── Public boost + queue promotion ────────────────────────────────────────

    /// @notice Cast one public boost on a queued binding to raise its priority.
    /// Open to anyone — boosts only reorder the queue (the keeper promotes by
    /// priority) and never touch the peer consensus verdict, so this is open
    /// participation, not a consensus vote. Two anti-spam guards: one boost per
    /// wallet per binding, plus a per-wallet BOOST_COOLDOWN between boosts so a
    /// single identity can't sweep-boost the whole queue. Active peers are exempt
    /// from the cooldown, mirroring the public submit-cooldown policy.
    function boostQueued(bytes32 id, bytes32 topicId) external whenNotPaused {
        bytes32 bid = bindingId(id, topicId);
        require(bindings[bid].state == EvidenceState.Queued, "not queued");
        require(!_boosted[bid][msg.sender], "already boosted");
        if (!isActivePeer[msg.sender]) {
            require(
                lastBoostAt[msg.sender] == 0 ||
                block.timestamp > uint256(lastBoostAt[msg.sender]) + BOOST_COOLDOWN,
                "boost cooldown active"
            );
            lastBoostAt[msg.sender] = uint48(block.timestamp);
        }
        _boosted[bid][msg.sender] = true;
        uint32 p = ++queuePriority[bid];
        emit QueueBoosted(bid, msg.sender, p);
    }

    /// @notice Promote a queued binding into active review once a slot is free.
    /// Permissionless: the keeper calls it in priority order, but anyone can call
    /// it so the queue drains even if the keeper is down — only ordering, never
    /// liveness, depends on the keeper.  The review clock starts here.
    function promote(bytes32 id, bytes32 topicId) external whenNotPaused {
        bytes32 bid = bindingId(id, topicId);
        Binding storage b = bindings[bid];
        require(b.state == EvidenceState.Queued, "not queued");
        require(activeReviewCount < reviewCapacity(), "no review slot");
        b.state        = EvidenceState.Submitted;
        b.submittedAt  = uint48(block.timestamp);
        b.peerSnapshot = uint32(activePeerCount);
        activeReviewCount++;
        // A promoted binding entering review is, to indexers, a fresh submission.
        emit BindingSubmitted(bid, id, topicId, evidences[id].tier, msg.sender);
    }

    // ── Challenge system ─────────────────────────────────────────────────────

    /// @notice Open a challenge, authorised by the challenger's EIP-712 signature
    /// (support = true).  The submitter may relay; attribution is the recovered
    /// signer, which must be an active peer.  phase = 1.
    function openChallenge(bytes32 id, bytes32 topicId, bytes32 noteHash, bytes calldata sig)
        external whenNotPaused
    {
        bytes32 bid = bindingId(id, topicId);
        Binding storage b = bindings[bid];
        // Sign over the round this open will create (current + 1), so an old
        // open-challenge signature can't be replayed to re-open a later round.
        address voter = _recoverVoter(bid, 1, true, b.challengeRound + 1, noteHash, sig);
        require(isActivePeer[voter], "not an active peer");

        require(
            lastChallengeAt[voter] == 0 ||
            block.timestamp > uint256(lastChallengeAt[voter]) + CHALLENGE_COOLDOWN,
            "challenge cooldown active"
        );

        require(
            b.state == EvidenceState.Canon || b.state == EvidenceState.Reaffirmed,
            "not canon"
        );
        // Per-binding cooldown: a binding can't be re-contested until its last
        // challenge window has closed plus a cooldown, so a rotating cast of
        // peers can't keep evidence perpetually in limbo.
        require(
            b.challengedAt == 0 ||
            block.timestamp > uint256(b.challengedAt) + CHALLENGE_WINDOW + RECHALLENGE_COOLDOWN,
            "rechallenge cooldown active"
        );

        uint32 round = ++b.challengeRound;
        b.state           = EvidenceState.Contested;
        b.challengedAt    = uint48(block.timestamp);
        b.challengeVotes  = 1;
        b.defenseVotes    = 0;
        b.peerSnapshot    = uint32(activePeerCount); // vestigial: challenge resolution uses the LIVE count

        _votedChallenge[bid][round][voter] = true;
        lastChallengeAt[voter] = uint48(block.timestamp);
        lastActive[voter]      = uint48(block.timestamp);

        emit ChallengeOpened(bid, id, topicId, voter, b.challengedAt);
        emit ChallengeVoteCast(bid, id, topicId, voter, true, b.challengeVotes, b.defenseVotes, sig);

        _resolveChallenge(bid, b);
    }

    /// @notice Cast a challenge vote authorised by the voter's EIP-712 signature.
    /// The submitter may relay; attribution is the recovered signer, which must be
    /// an active peer.  phase = 1.
    function castChallengeVote(bytes32 id, bytes32 topicId, bool supportChallenge, bytes32 noteHash, bytes calldata sig)
        external whenNotPaused
    {
        bytes32 bid = bindingId(id, topicId);
        Binding storage b = bindings[bid];
        address voter = _recoverVoter(bid, 1, supportChallenge, b.challengeRound, noteHash, sig);
        require(isActivePeer[voter], "not an active peer");

        require(b.state == EvidenceState.Contested, "not contested");
        require(block.timestamp <= uint256(b.challengedAt) + CHALLENGE_WINDOW, "window expired");
        require(!_votedChallenge[bid][b.challengeRound][voter], "already voted");

        _votedChallenge[bid][b.challengeRound][voter] = true;
        lastActive[voter] = uint48(block.timestamp);

        if (supportChallenge) b.challengeVotes++;
        else                  b.defenseVotes++;

        emit ChallengeVoteCast(bid, id, topicId, voter, supportChallenge, b.challengeVotes, b.defenseVotes, sig);

        _resolveChallenge(bid, b);
    }

    /// @notice Finalize a contested binding after the 21-day window.
    function finalizeChallenge(bytes32 id, bytes32 topicId) external whenNotPaused {
        bytes32 bid = bindingId(id, topicId);
        Binding storage b = bindings[bid];
        require(b.state == EvidenceState.Contested, "not contested");
        require(block.timestamp > uint256(b.challengedAt) + CHALLENGE_WINDOW, "window still open");
        _resolveChallenge(bid, b);
    }

    function _resolveChallenge(bytes32 bid, Binding storage b) internal {
        uint8 tier = evidences[b.evidenceId].tier;
        // Destroying canon is judged against the LIVE peer set, not the count
        // snapshotted at challenge-open: deprecation must always clear a supermajority
        // of the network as it stands now, so peers admitted during the challenge
        // window raise (never dilute) the bar.  Otherwise a stale, smaller snapshot
        // lets a sub-supermajority of the grown network deprecate canon evidence.
        if (b.challengeVotes >= _deprecateThresholdAt(tier, activePeerCount)) {
            b.state = EvidenceState.Deprecated;
            emit BindingDeprecated(bid, b.evidenceId, b.topicId, b.challengeVotes);
            return;
        }
        if (block.timestamp > uint256(b.challengedAt) + CHALLENGE_WINDOW) {
            b.state = EvidenceState.Reaffirmed;
            emit BindingReaffirmed(bid, b.evidenceId, b.topicId, b.defenseVotes);
        }
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice True iff `who` has voted in the relevant phase for binding `bid`.
    /// phase 0 = review; phase 1 = the *current* challenge round.
    function hasVoted(bytes32 bid, uint8 phase, address who) external view returns (bool) {
        if (phase == 0) return _votedReview[bid][bindings[bid].reviewRound][who];
        return _votedChallenge[bid][bindings[bid].challengeRound][who];
    }

    function getEvidence(bytes32 id) external view returns (Evidence memory) {
        return evidences[id];
    }

    function getBinding(bytes32 id, bytes32 topicId) external view returns (Binding memory) {
        return bindings[bindingId(id, topicId)];
    }

    // Peer/nominee aggregation, challenge-cooldown, and genesis checks are
    // read-only and moved to the external EvidenceConsensusLens (a sidecar that
    // reads this contract's public state) to keep the core runtime under EIP-170.
    // See contracts/EvidenceConsensusLens.sol.
}
