// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./EvidenceConsensus.sol";

/// @title EvidenceArchive
/// @notice On-chain home for the human-readable strings the core only commits as
/// hashes — evidence content, taxonomy node metadata, and deliberation note text.
///
/// The core {EvidenceConsensus} stores a `contentHash` per evidence, a `metaHash`
/// per taxonomy node, and a `noteHash` inside every signed vote, but the readable
/// JSON / note text lives only off-chain (Supabase). That makes the chain unable
/// to reproduce a single title, source, link, pillar/topic name, or note if the
/// off-chain store is wiped. This sidecar closes that gap so the chain is a
/// complete, self-sufficient backup and the off-chain DB is a pure projection.
///
/// Design mirrors {EvidenceConsensusLens}: it holds an immutable reference to the
/// core, adds ZERO bytecode to the core (which sits at the EIP-170 limit), and
/// has no privileges. Every write is **self-verifying against an on-chain hash**,
/// so what is stored cannot drift from what consensus committed, and anyone may
/// (re)publish or backfill permissionlessly:
///   - evidence content / node meta are checked against the core's `contentHash`
///     / `metaHash` (the published string must hash to the value consensus holds);
///   - a note is keyed by `keccak256(text)`, which is exactly the `noteHash` the
///     signed vote committed — so the indexer joins note text back to any vote,
///     across review / challenge / taxonomy / retire / force-renounce / nominate /
///     endorse / revoke, by that hash.
///
/// The canonical strings passed in MUST be byte-identical to the strings hashed
/// by `computeContentHash` / `computeMetaHash` / `noteHashOf` in
/// src/lib/wallet-impl.js (not a re-serialization), or the require reverts.
contract EvidenceArchive {
    EvidenceConsensus public immutable core;

    /// @notice Byte caps for the two attacker-controllable, NON-hash-verified
    /// strings (`extra` and note `text`), to bound permanent state-bloat griefing
    /// on a public chain.  Hash-verified strings (content / meta) need no cap: a
    /// caller can only ever store the exact string consensus already committed to.
    uint256 public constant MAX_EXTRA_BYTES = 8_192;
    uint256 public constant MAX_NOTE_BYTES  = 8_192;

    /// evidenceId => canonical content JSON ({title,source,year,excerpt,link,tier})
    mapping(bytes32 => string) public evidenceContent;
    /// evidenceId => extra fields not bound by contentHash ({type,tags,...}).
    /// ⚠ UNVERIFIED: not covered by any on-chain hash, and publishing is
    /// permissionless, so anyone can set/overwrite this for a real evidence id.
    /// A rebuild MUST treat it as advisory only (prefer the off-chain projection;
    /// never trust it for anything security-relevant), exactly as it MUST join
    /// `noteText` back to a genuine vote event by hash.
    mapping(bytes32 => string) public evidenceExtra;
    /// nodeId => canonical meta JSON ({kind,slug,parent,title,blurb,tag})
    mapping(bytes32 => string) public nodeMeta;
    /// noteHash => note text (noteHash == keccak256(text)).  ⚠ Any non-empty
    /// string is publishable: a junk note whose hash matches no vote is inert
    /// (never joined), but consumers must NOT surface NotePublished without first
    /// matching its hash to a real vote event.
    mapping(bytes32 => string) public noteText;

    event EvidenceContentPublished(bytes32 indexed id, bytes32 contentHash, string canonical, string extra);
    event NodeMetaPublished(bytes32 indexed id, bytes32 metaHash, string canonical);
    event NotePublished(bytes32 indexed noteHash, string text);

    constructor(EvidenceConsensus _core) {
        core = _core;
    }

    // ── Evidence content ──────────────────────────────────────────────────────

    /// @notice Publish the readable content of a registered evidence. `canonical`
    /// must be the exact JSON whose keccak is the core's stored `contentHash`;
    /// `extra` carries non-hashed fields (type, tags) for completeness.
    function publishEvidenceContent(bytes32 id, string calldata canonical, string calldata extra) external {
        bytes32 h = core.getEvidence(id).contentHash;
        require(h != bytes32(0), "unknown evidence");
        require(keccak256(bytes(canonical)) == h, "content hash mismatch");
        require(bytes(extra).length <= MAX_EXTRA_BYTES, "extra too long");
        evidenceContent[id] = canonical;
        evidenceExtra[id]   = extra;
        emit EvidenceContentPublished(id, h, canonical, extra);
    }

    // ── Taxonomy node metadata ────────────────────────────────────────────────

    /// @notice Publish the readable metadata of a taxonomy node (pillar or topic).
    /// `canonical` must hash to the node's on-chain `metaHash`.
    function publishNodeMeta(bytes32 id, string calldata canonical) external {
        bytes32 h = core.getTaxonomyNode(id).metaHash;
        require(h != bytes32(0), "unknown node");
        require(keccak256(bytes(canonical)) == h, "meta hash mismatch");
        nodeMeta[id] = canonical;
        emit NodeMetaPublished(id, h, canonical);
    }

    function publishNodeMetas(bytes32[] calldata ids, string[] calldata canonicals) external {
        require(ids.length == canonicals.length, "length mismatch");
        for (uint256 i = 0; i < ids.length; i++) {
            bytes32 h = core.getTaxonomyNode(ids[i]).metaHash;
            require(h != bytes32(0), "unknown node");
            require(keccak256(bytes(canonicals[i])) == h, "meta hash mismatch");
            nodeMeta[ids[i]] = canonicals[i];
            emit NodeMetaPublished(ids[i], h, canonicals[i]);
        }
    }

    // ── Deliberation notes ────────────────────────────────────────────────────

    /// @notice Publish a note's text. It is keyed by `keccak256(text)`, which is
    /// the `noteHash` the signed vote committed — so no cross-call to the core is
    /// needed; the binding to a specific act is the vote event's `noteHash`.
    /// Empty notes are rejected: `noteHashOf("")` is the `ZeroHash` "no note"
    /// sentinel, so there is never text to recover for one.
    function publishNote(string calldata text) external {
        require(bytes(text).length != 0, "empty note");
        require(bytes(text).length <= MAX_NOTE_BYTES, "note too long");
        bytes32 h = keccak256(bytes(text));
        noteText[h] = text;
        emit NotePublished(h, text);
    }

    function publishNotes(string[] calldata texts) external {
        for (uint256 i = 0; i < texts.length; i++) {
            require(bytes(texts[i]).length != 0, "empty note");
            require(bytes(texts[i]).length <= MAX_NOTE_BYTES, "note too long");
            bytes32 h = keccak256(bytes(texts[i]));
            noteText[h] = texts[i];
            emit NotePublished(h, texts[i]);
        }
    }
}
