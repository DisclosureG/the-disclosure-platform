// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PeerGovernance
 * @notice Peer-membership governance for {EvidenceConsensus}.
 *
 * The nominee (admission) and revocation (removal) flows were moved out of the
 * core contract to keep its runtime under the EIP-170 24576-byte limit while
 * the EIP-712 vote-by-signature machinery was added to the hot voting path.
 * Those flows do not touch the vote path — they only need the core's peer
 * REGISTRY state (isActivePeer / activePeerCount), which still lives in the
 * core.  This contract holds its OWN nominee/revocation bookkeeping and mutates
 * the core's peer set through the privileged `gAddPeer` / `gRemovePeer` hooks
 * (gated on `onlyGovernance` in the core, wired once via `setGovernance`).
 *
 * The core remains the source of truth for who is a peer; this contract is the
 * only authorized path (besides seed-phase owner addPeer and inactivity GC) to
 * change that set after the seed phase.
 */
interface IEvidenceCore {
    function isActivePeer(address) external view returns (bool);
    function activePeerCount() external view returns (uint256);
    function seedPhaseK() external view returns (uint256);
    function owner() external view returns (address);
    function paused() external view returns (bool);
    function peerHandle(address) external view returns (string memory);
    function gAddPeer(address peer, string calldata handle) external;
    function gRemovePeer(address peer) external;
}

contract PeerGovernance {

    IEvidenceCore public immutable core;

    // ── EIP-712 vote-by-signature ─────────────────────────────────────────────
    //
    // Every membership VOTE (nominee endorsement, revocation discard) is
    // authorised by an EIP-712 `PeerVote` the voter signs in their wallet, bound
    // to the subject, the vote kind, and the subject's CURRENT round (anti-replay
    // across re-nominations / re-motions) plus a `noteHash` that commits an
    // optional off-chain deliberation note. This mirrors the core's evidence
    // vote-by-signature; the note TEXT stays off-chain (only its hash is signed).
    bytes32 private immutable _DOMAIN_SEPARATOR;
    bytes32 private constant _PEERVOTE_TYPEHASH =
        keccak256("PeerVote(address subject,uint8 kind,bool support,uint32 round,bytes32 noteHash)");
    uint8 internal constant KIND_NOMINEE  = 0; // endorse a nominee (admission)
    uint8 internal constant KIND_REVOKE   = 1; // discard a peer  (removal)
    uint8 internal constant KIND_NOMINATE = 2; // open a nomination (the nominator is endorsement #1)

    constructor(address core_) {
        core = IEvidenceCore(core_);
        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("PeerGovernance")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice The EIP-712 domain separator (name "PeerGovernance", version "1").
    /// Exposed so clients can sanity-check the domain they sign against.
    function DOMAIN_SEPARATOR() external view returns (bytes32) { return _DOMAIN_SEPARATOR; }

    /// @notice Recover the signer of a PeerVote(subject, kind, support, round,
    /// noteHash). Reverts on a malformed signature.
    function _recoverPeerVoter(
        address subject, uint8 kind, bool support, uint32 round, bytes32 noteHash, bytes calldata sig
    ) internal view returns (address) {
        require(sig.length == 65, "bad sig len");
        bytes32 structHash = keccak256(abi.encode(_PEERVOTE_TYPEHASH, subject, kind, support, round, noteHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, structHash));
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad sig");
        return signer;
    }

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MAX_HANDLE_BYTES = 64;
    uint256 public constant PROPOSAL_WINDOW   = 30 days; // nominee expiry
    uint256 public constant REVOKE_WINDOW     = 14 days; // revocation motion expiry

    // ── Nominee registry ─────────────────────────────────────────────────────

    address[] private _nomineeList;
    mapping(address => uint256) private nomineeIndex;     // 1-based
    mapping(address => bool)    public isNominated;
    mapping(address => string)  public nomineeHandle;
    mapping(address => address) public nomineeBy;
    mapping(address => uint48)  public nomineeAt;
    mapping(address => uint32)  public nomineeEndorsements;
    mapping(address => uint32)  public nomineeRound;      // bumped per (re-)nomination; isolates endorsements
    // _endorsedNominee[nominee][round][endorser] — fresh eligibility each nomination.
    mapping(address => mapping(uint32 => mapping(address => bool))) private _endorsedNominee;

    // ── Revocation state ─────────────────────────────────────────────────────

    mapping(address => bool)   public revocationActive;
    mapping(address => uint32) public revokeVoteCount;
    mapping(address => uint48) public revokeMotionAt;     // motion open time (for expiry)
    mapping(address => uint32) public revokeRound;        // bumped per motion; isolates votes
    // _votedRevoke[peer][round][voter] — fresh eligibility each motion.
    mapping(address => mapping(uint32 => mapping(address => bool))) private _votedRevoke;

    // ── Events ───────────────────────────────────────────────────────────────

    event PeerNominated       (address indexed nominee, string handle, address indexed nominatedBy, uint256 threshold);
    event PeerEndorsed        (address indexed nominee, address indexed endorser, uint32 endorsements, uint256 threshold);
    event NomineeVerified     (address indexed peer, string handle, uint256 activePeerCount);
    event NomineeLapsed       (address indexed nominee);

    event RevocationMotioned  (address indexed peer, address indexed by, uint256 threshold);
    event RevocationVoteCast  (address indexed peer, address indexed voter, uint32 votes, uint256 threshold);
    event RevocationCancelled (address indexed peer);
    event PeerRevoked         (address indexed peer, uint256 activePeerCount);

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyActivePeer() {
        require(core.isActivePeer(msg.sender), "not an active peer");
        _;
    }

    modifier whenNotPaused() {
        require(!core.paused(), "paused");
        _;
    }

    // ── Threshold / gate helpers ──────────────────────────────────────────────

    /// @notice Admission / taxonomy gate — floor(n/3) + 1, i.e. STRICTLY more
    /// than one third of peers.
    function nomineeThreshold() public view returns (uint256) {
        return core.activePeerCount() / 3 + 1; // ≥ 1 for all n ≥ 0
    }

    function revokeThreshold() public view returns (uint256) {
        uint256 raw = (core.activePeerCount() + 1) / 2; // ceiling(n / 2)
        return raw < 1 ? 1 : raw;
    }

    /// @notice Community nomination is open once the seed phase is reached.  If
    /// the active set later dips below seedPhaseK while the owner is still seated,
    /// the gate re-closes so the owner can re-seed.  But once the owner has
    /// renounced there is no one left to re-seed, so nominations stay open
    /// unconditionally — otherwise a post-renounce shrink below seedPhaseK would
    /// permanently strand the network (unable to grow, only shrink).
    function nominationsOpen() public view returns (bool open) {
        return core.activePeerCount() >= core.seedPhaseK() || core.owner() == address(0);
    }

    // ── Nominee flow ─────────────────────────────────────────────────────────

    function nominatePeer(address nominee, string calldata handle, bytes32 noteHash, bytes calldata sig)
        external onlyActivePeer whenNotPaused
    {
        require(nominationsOpen(), "seed phase: owner must seed peers first");
        require(nominee != address(0), "zero address");
        require(!core.isActivePeer(nominee), "already a peer");
        require(!isNominated[nominee], "already nominated");
        require(bytes(handle).length <= MAX_HANDLE_BYTES, "handle too long");

        // The nominator signs a PeerVote over the nominee at the round this
        // nomination mints. They are NOT endorsement #1 (endorsements start at 0);
        // the signature only proves the nomination is the nominator's own act.
        uint32 round = ++nomineeRound[nominee];
        require(_recoverPeerVoter(nominee, KIND_NOMINATE, true, round, noteHash, sig) == msg.sender, "bad sig");
        isNominated[nominee]         = true;
        nomineeHandle[nominee]       = handle;
        nomineeBy[nominee]           = msg.sender;
        nomineeAt[nominee]           = uint48(block.timestamp);
        nomineeEndorsements[nominee] = 0;

        _nomineeList.push(nominee);
        nomineeIndex[nominee] = _nomineeList.length; // 1-based

        emit PeerNominated(nominee, handle, msg.sender, nomineeThreshold());
    }

    function endorseNominee(address nominee, bytes32 noteHash, bytes calldata sig)
        external onlyActivePeer whenNotPaused
    {
        require(isNominated[nominee], "not nominated");
        uint32 round = nomineeRound[nominee];
        require(_recoverPeerVoter(nominee, KIND_NOMINEE, true, round, noteHash, sig) == msg.sender, "bad sig");
        require(!_endorsedNominee[nominee][round][msg.sender], "already endorsed");

        _endorsedNominee[nominee][round][msg.sender] = true;
        nomineeEndorsements[nominee]++;

        uint256 threshold = nomineeThreshold();
        emit PeerEndorsed(nominee, msg.sender, nomineeEndorsements[nominee], threshold);
        _checkNominee(nominee, threshold);
    }

    function _checkNominee(address nominee, uint256 threshold) internal {
        if (nomineeEndorsements[nominee] >= threshold) {
            string memory handle = nomineeHandle[nominee];
            _removeNominee(nominee);
            core.gAddPeer(nominee, handle);
            emit NomineeVerified(nominee, handle, core.activePeerCount());
        }
    }

    /// @notice True iff `endorser` has endorsed the *current* nomination round of
    /// `nominee`.  Stable across re-nominations thanks to per-nomination rounds.
    function hasEndorsed(address nominee, address endorser) external view returns (bool) {
        return _endorsedNominee[nominee][nomineeRound[nominee]][endorser];
    }

    /// @notice Garbage-collect a nominee that never reached its endorsement gate,
    /// so the address can be nominated again fresh.  Permissionless after the
    /// window; the next nomination gets a new round (so prior endorsers may
    /// endorse again).
    function lapseNominee(address nominee) external whenNotPaused {
        require(isNominated[nominee], "not nominated");
        require(block.timestamp > uint256(nomineeAt[nominee]) + PROPOSAL_WINDOW, "window still open");
        _removeNominee(nominee);
        emit NomineeLapsed(nominee);
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
        nomineeEndorsements[nominee] = 0;
    }

    function nomineeList() external view returns (address[] memory) {
        return _nomineeList;
    }

    // ── Revocation flow ──────────────────────────────────────────────────────

    function motionRevoke(address peer, bytes32 noteHash, bytes calldata sig)
        external onlyActivePeer whenNotPaused
    {
        require(core.isActivePeer(peer), "not active peer");
        require(!revocationActive[peer], "revocation already active");
        require(peer != msg.sender, "cannot self-revoke");

        // A motion opens the new round AND casts discard vote #1, so the signed
        // round is the round this motion creates (current + 1).
        uint32 round = ++revokeRound[peer];
        require(_recoverPeerVoter(peer, KIND_REVOKE, true, round, noteHash, sig) == msg.sender, "bad sig");
        revocationActive[peer]              = true;
        revokeMotionAt[peer]                = uint48(block.timestamp);
        revokeVoteCount[peer]               = 1;
        _votedRevoke[peer][round][msg.sender] = true;

        uint256 threshold = revokeThreshold();
        emit RevocationMotioned(peer, msg.sender, threshold);
        emit RevocationVoteCast(peer, msg.sender, 1, threshold);

        _checkRevocation(peer, threshold);
    }

    function voteRevoke(address peer, bytes32 noteHash, bytes calldata sig)
        external onlyActivePeer whenNotPaused
    {
        require(revocationActive[peer], "no revocation active");
        uint32 round = revokeRound[peer];
        require(_recoverPeerVoter(peer, KIND_REVOKE, true, round, noteHash, sig) == msg.sender, "bad sig");
        require(!_votedRevoke[peer][round][msg.sender], "already voted");

        _votedRevoke[peer][round][msg.sender] = true;
        revokeVoteCount[peer]++;

        uint256 thresh = revokeThreshold();
        emit RevocationVoteCast(peer, msg.sender, revokeVoteCount[peer], thresh);

        _checkRevocation(peer, thresh);
    }

    /// @notice Clear a stale revocation motion that never reached a majority,
    /// so the peer is not left under a permanent cloud and the motion can be
    /// re-opened fresh later.  Permissionless after the window.
    function cancelStaleRevocation(address peer) external whenNotPaused {
        require(revocationActive[peer], "no revocation active");
        require(block.timestamp > uint256(revokeMotionAt[peer]) + REVOKE_WINDOW, "window still open");
        revocationActive[peer] = false;
        revokeVoteCount[peer]  = 0;
        emit RevocationCancelled(peer);
    }

    function _checkRevocation(address peer, uint256 thresh) internal {
        if (revokeVoteCount[peer] >= thresh) {
            revocationActive[peer] = false;
            revokeVoteCount[peer]  = 0; // reset so a re-added peer starts clean (core's _removePeer used to do this)
            core.gRemovePeer(peer);
            emit PeerRevoked(peer, core.activePeerCount());
        }
    }

    /// @notice True iff `voter` has voted on the *current* revocation motion
    /// against `peer`.  Stable across re-motions thanks to per-motion rounds.
    function hasVotedRevoke(address peer, address voter) external view returns (bool) {
        return _votedRevoke[peer][revokeRound[peer]][voter];
    }
}
