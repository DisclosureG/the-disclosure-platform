# Project Notes

This file is read by Claude Code on every session start. Keep it small and
authoritative — pointers to source, not duplicated content.

## On-chain archive — "Evidence"

The project runs a single smart contract on BSC. The public archive is branded
**Evidence — the DeSci Network** (decentralized science) in the UI; the
on-chain contract and the Supabase tables keep the `EvidenceConsensus` /
`evidence` names.

- **`EvidenceConsensus`** — holds the canonical peer set, nominee/revoke
  governance, the **Pillar → Topic taxonomy**, and evidence records under a
  7-state lifecycle.
  - Contract: [blockchain/contracts/EvidenceConsensus.sol](blockchain/contracts/EvidenceConsensus.sol)
  - Public archive: [src/pages/Evidence.jsx](src/pages/Evidence.jsx) → `/evidence/`

### Complete on-chain backup — `EvidenceArchive`

The core commits only **hashes** of human-authored data (evidence `contentHash`,
node `metaHash`, vote `noteHash`); the readable strings used to live only in
Supabase, so a DB wipe was unrecoverable. **`EvidenceArchive`** closes that gap so
the chain is a self-sufficient backup and **Supabase is a disposable projection**.

- Contract: [blockchain/contracts/EvidenceArchive.sol](blockchain/contracts/EvidenceArchive.sol)
  — a read-adjacent sidecar (like the Lens) holding the **immutable core** address.
  Stores + emits three string types, each **self-verified against an on-chain
  hash** (so stored bytes can't drift and anyone may publish/backfill):
  `publishEvidenceContent(id, canonical, extra)` (checked vs `core.getEvidence(id).contentHash`),
  `publishNodeMeta(id, canonical)` (vs `core.getTaxonomyNode(id).metaHash`),
  `publishNote(text)` (keyed by `keccak256(text)` == the vote's `noteHash`). **Zero
  core bytecode impact** — deploy against the *existing* core, no core redeploy / db reset.
- The published `canonical` string MUST be byte-identical to the string hashed by
  `canonicalContentJSON` / `canonicalMetaJSON` / `noteHashOf` in
  [src/lib/wallet-impl.js](src/lib/wallet-impl.js) (publish that exact string, not a re-stringify).
- **How content gets on-chain:** the **`archive-flush`** keeper edge fn (pg_cron,
  every 2 min) reads off-chain rows and publishes any not-yet-on-chain content /
  meta / notes via the keeper wallet — this is both the live sweep AND the backfill
  tool. Loss window before a wipe = the cron interval; run it on-demand before
  risky DB ops. (`publish*OnChain` helpers exist in wallet-impl for a future
  manual button; the keeper is the automatic path.)
- **Rebuild from chain:** `chain-indexer-evidence` decodes
  `EvidenceContentPublished` / `NodeMetaPublished` / `NotePublished` and **upserts**
  the readable fields back into `evidence` / `pillars` / `topics` / `archive_notes`
  (+ backfills `attestations`/`gov_votes` note text by `note_hash`). These handlers
  are purely additive (never touch lifecycle status). NB: a *perfect* from-empty
  replay of relational **status/lifecycle** still needs the existing
  proposed/ratified/binding handlers made order-independent — a follow-up — but all
  source data is on-chain and directly readable via the archive getters.
- Deploy: `CORE_ADDR=0x… npx hardhat run scripts/deploy-archive.js --network bscMainnet`
  (also wired into `deploy-consensus.js` / `finish-deploy.js`). Then set
  `VITE_CONTENT_ARCHIVE_ADDR` + edge secret `CONTENT_ARCHIVE_ADDR`, redeploy the
  indexer + frontend, and let `archive-flush` backfill.

> The companion "alignment" / behaviour archive (`BehaviourConsensus`) was
> removed. Do not re-add a behaviour contract, table, edge function, or page.

## Taxonomy — Pillar → Topic → Evidence

The archive grows **wider** (pillars) and **deeper** (topics) by on-chain peer
consensus; evidence is filed under a ratified topic.

- **A taxonomy node is never empty.** Every pillar is proposed *bundled with* its
  first topic AND a founding piece of evidence; every topic is proposed *bundled
  with* a founding piece of evidence. The whole bundle rides on one endorsement
  gate — at ratification the node (and, for a pillar, its founding topic)
  ratifies and the founding evidence's `(evidence, topic)` binding is canonized
  **atomically**. The founding evidence is accepted as part of the taxonomy vote,
  not through tier-based review. Further evidence is added to a ratified topic
  with `submitEvidence` / `fileBinding` (normal review).
- Node id = `bytes32 = keccak256(slug)`; metadata is off-chain, committed as
  `metaHash = keccak256(canonical JSON)`. Lifecycle mirrors the nominee flow:
  `proposePillar(id, metaHash, topicId, topicMetaHash, evidenceId, tier, contentHash)`
  / `proposeTopic(id, parentPillar, metaHash, evidenceId, tier, contentHash)` →
  `endorseNode` → auto-ratify at the bundle gate = max(taxonomy majority,
  `canonizeThreshold(tier)`) so founding evidence is never canonized on a cheaper
  vote than the normal review path (proposer counts as endorsement #1). A still-pending pillar reserves its bundled topic id
  (`topicReserved`) so nothing else can claim it before ratification. The
  off-chain bundle insert is `proposeTaxonomyBundle()` in
  [src/evidence-data.js](src/evidence-data.js).
- **Electorate is FROZEN per proposal (`nodeSnapshot`).** `activePeerCount` is
  snapshotted when a proposal is (re-)registered, and the bundle gate AND the
  "ratify impossible" test are judged against that frozen count — mirroring the
  binding-review `peerSnapshot`. So a peer-set shrink mid-proposal can neither
  lower the ratify bar nor terminally burn a still-ratifiable id on a tally that
  counts since-departed peers. The same freeze covers retire / force-renounce
  (`nodeSnapshot` reused for retire; `forceRenounceSnapshot`) and the
  governance nominee/revoke gates (`nomineeSnapshot` / `revokeSnapshot`).
- **A proposal resolves three ways:** ratified (gate reached), **Rejected**, or
  Lapsed. `rejectNode(id, noteHash, sig)` is the dissent vote (taxonomy phase,
  `support=false`; one act per peer per round — endorse OR reject, never both).
  The moment rejections make ratification arithmetically impossible
  (`rejections + bundleThreshold(tier) > nodeSnapshot`, judged against the FROZEN
  propose-time count — see `nodeSnapshot` above — so a shrink can't burn a still-
  ratifiable id) the node flips to **terminal `NodeState.Rejected`** — its id is
  burned and can't be re-proposed, like an Expelled binding. Reservations (founding evidence + bundled
  topic) are freed. A pure **timeout** is always a re-filable **Lapse**
  (`lapseProposal` GCs the node back to `None`); terminal rejection comes only from
  an active reject consensus, so peer-set churn that merely stalls a proposal can't
  permanently burn its id (`_settleNode` is the shared resolver). The note text for
  reject rides in the signed `noteHash` (on-chain) but is not yet persisted
  off-chain for browsing — a follow-up, same as retire/force-renounce.
- **Evidence × (pillar → topic) bindings.** A single evidence has one canonical
  id + one `contentHash`, but is filed under any number of topics. Each
  `(evidence, topic)` pair is a **binding** — an independent voting unit with its
  own 7-state lifecycle and tallies. `bindingId = keccak256(abi.encode(id, topicId))`.
  Only canon/reaffirmed bindings enter the public archive; rejected ones stay
  on-chain. `submitEvidence(id, tier, topicId, contentHash)` registers the
  evidence + its first binding; `fileBinding(id, topicId)` cross-lists it under
  another topic. Voting/challenge calls take `(id, topicId)`.
- `contentHash` binds the **content only** (title/source/year/excerpt/link/tier —
  NOT topic_id), so cross-listing never rehashes a record. Keep `computeContentHash`
  in [src/lib/wallet-impl.js](src/lib/wallet-impl.js) and the recompute in the
  `audit-content-hash` / `verify-attestation` edge functions byte-identical.
- Hashing source of truth: `computeMetaHash` / `slugToBytes32` in
  [src/lib/wallet-impl.js](src/lib/wallet-impl.js) (also recomputed in
  `audit-content-hash` / `verify-attestation`). The clean slate ships **no
  baseline** — peers create every pillar/topic via the propose flow on
  [/evidence](src/pages/Evidence.jsx) and ratify on the Peer Review Taxonomy tab.
  UI taxonomy loads via `useTaxonomy()` in [src/evidence-data.js](src/evidence-data.js).

## Peer review surface

`/peer-review/` is the wallet-gated workspace for verified peers. A connect
screen gates entry; the connected workspace shows a peer/stats banner and a
sticky 5-tab strip: **Review queue** (pending bindings grouped pillar→topic, one
vote per binding), **Challenges** (contested bindings, support/defend),
**Attestation log** (per-pillar searchable), **Taxonomy** governance (endorse to
verify pillar/topic proposals), and **Peer registry** (nominate/endorse/revoke).
See [src/pages/PeerReview.jsx](src/pages/PeerReview.jsx). The whole surface is
built on the slate **Cosmos** design system in
[src/styles/shared.css](src/styles/shared.css) + [src/styles/peer-review.css](src/styles/peer-review.css).

The Peer registry tab has a **Registry / Vote history** toggle: the roster, or a
searchable/paginated registry vote log (`usePeerRegistryLog`) that merges on-chain
governance events with the off-chain note records.

### Every peer governance act is EIP-712 vote-by-signature

**All** peer-side proposals / votes / endorsements / motions are EIP-712-signed and
recovered **on-chain**, each binding an optional deliberation `noteHash` (the note
*text* lives off-chain; only its keccak rides in the signature). The UI captures an
optional note via a sign modal for every one. Two EIP-712 structs carry everything:

- **Core `Vote(bindingId,phase,support,round,noteHash)`** (domain "EvidenceConsensus",
  `verifyingContract` = core) — `phase` keys the act: 0 review, 1 challenge, **2
  taxonomy (`proposePillar`/`proposeTopic`/`endorseNode` with `support=true`,
  `rejectNode` with `support=false`; `bindingId` = node id), 3
  retire (`motionRetireNode`/`voteRetireNode`; `bindingId` = node id), 4 force-renounce
  (`motionForceRenounce`/`voteForceRenounce`; `bindingId` = `keccak256("force-renounce")`)**.
  A propose/motion signs the round it mints (`current + 1`); an endorse/vote signs the
  current round. Sources of truth: `VOTE_TYPES` / `VOTE_PHASE` / `FORCE_RENOUNCE_ID` in
  [src/lib/wallet-constants.js](src/lib/wallet-constants.js); `_VOTE_TYPEHASH` + the
  `_PHASE_*` / `_FORCE_RENOUNCE_ID` constants in
  [blockchain/contracts/EvidenceConsensus.sol](blockchain/contracts/EvidenceConsensus.sol).
- **Gov `PeerVote(subject,kind,support,round,noteHash)`** (domain "PeerGovernance",
  `verifyingContract` = gov sidecar) — `kind`: 0 nominee endorse, 1 revocation discard,
  **2 nominate (the nominator's own signed act)**. `PeerGovernance.endorseNominee` /
  `motionRevoke` / `voteRevoke` / `nominatePeer` take `(noteHash, sig)` and `require`
  the recovered signer == `msg.sender`. Source of truth: `PEER_VOTE_TYPES` /
  `PEER_GOVERNANCE_DOMAIN` / `PEER_VOTE_KIND`; the `_PEERVOTE_TYPEHASH` + domain in
  [blockchain/contracts/PeerGovernance.sol](blockchain/contracts/PeerGovernance.sol).

Still **not** votes: `lapseProposal`/`lapseNominee`/`cancelStale*`/`pruneInactivePeer`/
`promote`/`boostQueued`/`markLapsed`/`finalizeChallenge` (permissionless GC/queue),
owner-seed `addPeer`, and `submitEvidence`/`fileBinding` (content entry — reviewed
*after* filing). `keep` stays an off-chain Attestation dissent; taxonomy **reject**
is now an on-chain vote (`rejectNode`, taxonomy phase `support=false`) — no longer
Attestation-only. The off-chain note text is recorded via
edge fns that re-verify the same signature the chain recovered: review/challenge/taxonomy
endorse+reject → `verify-attestation` (the `endorse_node`/`reject_node` row carries
`node_hash`+`round`+`note_hash` so the public proof modal recovers its Vote — endorse
verified against the `NodeEndorsed` event, reject against `NodeRejectVoteCast`);
nominate/endorse → `nominee-vote` (verdicts `nominate`/`endorse`); revocation →
`revocation-vote`. The indexer flips the off-chain pillar/topic row to `status='rejected'`
on the terminal `NodeRejected` event (mirroring how `ProposalLapsed` → `lapsed`), and
`vote_log_view` projects an authoritative "Network rejected" row from that same event
(verdict `rejected`). Every reject-facing surface reads the chain: the peer-review queue
greys a doomed proposal from the **on-chain** rejection count (`Lens.getProposedNodes` now
returns `rejections[]`, matching the contract's `rejections + bundleThreshold > peers`),
not an off-chain tally.

> Domains/typehashes in the contracts must stay byte-identical with the edge-fn
> `buildDomain()` / `peerVoteDomain()` and the `VOTE_TYPES` / `PEER_VOTE_TYPES` mirrors.
> The note text for **retire** and **force-renounce** is currently committed on-chain
> (in the signed `noteHash`) but not yet persisted off-chain for browsing — a follow-up.

> **Deploying this needs a FULL redeploy** (core + PeerGovernance + Lens via
> `deploy-consensus.js`), not a PeerGovernance-only swap: the core's
> `setGovernance` is one-shot (`require(governance == address(0))`), so an existing
> core can't be re-pointed at a new gov. A fresh deploy resets all on-chain state.
> After deploy update `VITE_CONSENSUS_*` + edge secrets `CONSENSUS_ADDR`/`GOVERNANCE_ADDR`,
> push the `nominee_votes` migration, and redeploy the `nominee-vote`/`revocation-vote` fns.

## Supabase

One pipeline, one registry:

| Concern | Table / function |
|---|---|
| Evidence content | `evidence` (canonical content + `content_hash`; lifecycle lives on bindings) |
| Voting unit | `bindings` (`(evidence_id, topic_id)`, per-binding status + tallies, `binding_hash`) |
| Taxonomy | `pillars` / `topics` (status proposed→ratified \| rejected \| lapsed \| retired, joined by `node_hash`) |
| Attestations | `attestations` (one per `(binding_id, peer_addr, phase)`) |
| Peer-vote notes | `nominee_votes` (endorse) · `revocation_votes` (keep + discard) — off-chain note + sig for membership votes |
| Chain events | `chain_events` / `chain_event_cursor` |
| Tamper alerts | `tamper_alerts` |
| On-chain note backup | `archive_notes` (`note_hash` → text, rebuilt from `EvidenceArchive.NotePublished`) |
| Indexer edge fn | `chain-indexer-evidence` (also decodes the 3 `EvidenceArchive` events) |
| Verify edge fn | `verify-attestation` |
| Peer-vote edge fns | `nominee-vote` (endorse) · `revocation-vote` (keep + discard) |
| Audit edge fn | `audit-content-hash` |
| Archive backup keeper | `archive-flush` (cron every 2 min — publishes content/meta/notes to `EvidenceArchive`; live sweep + backfill) |
| Atomic vote RPCs | `apply_review_counts` / `apply_challenge_counts` |
| Throttle prefixes in `edge_rate_limit` | `ev_insert:` (evidence) · `tax_insert:` (taxonomy) · `revoke:` · `nominee:` |

The entire schema is a **single consolidated migration**
([supabase/migrations/20260521120000_consolidated_schema.sql](supabase/migrations/20260521120000_consolidated_schema.sql))
that builds everything from an empty database with **zero seed data** (0
evidence, 0 pillars, 0 topics). It replaced the historical incremental chain,
which couldn't replay on a fresh project (early patches referenced
dashboard-only objects). Peers create the taxonomy and file evidence at runtime.

> Spinning up a new project: `supabase db push` applies the one migration, then
> set the vault secrets so the cron invokers work:
> `select vault.create_secret('https://<ref>.supabase.co','project_url');` and
> `select vault.create_secret('<service-role-key>','service_role_key');`

## Required env vars

### Frontend (`.env.local`, Netlify)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `VITE_CONSENSUS_CHAIN_ID` (default 97 = BSC testnet)
- `VITE_CONSENSUS_ADDR` — deployed EvidenceConsensus
- `VITE_CONTENT_ARCHIVE_ADDR` — deployed EvidenceArchive (on-chain content backup)
- `VITE_CONSENSUS_READ_RPC` (optional; falls back to MetaMask)

### Supabase edge function secrets
- `CONSENSUS_ADDR`, `CONSENSUS_RPC_URL`, `CONSENSUS_CHAIN_ID`
- `CONTENT_ARCHIVE_ADDR` — EvidenceArchive (read by the indexer + `archive-flush` keeper)
- `KEEPER_PRIVATE_KEY` — funded wallet that signs `archive-flush` publish txs (same keeper as consensus-keeper)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase auto-sets these)

### Vault secrets (set once after deploy via SQL)
- `project_url`, `service_role_key` — used by `pg_cron` to invoke edge functions

## Local commands

- Frontend dev: `npm run dev`
- Frontend build: `npm run build`
- Contracts compile: `cd blockchain && npx hardhat compile`
- Contracts test: `cd blockchain && npx hardhat test` (the Hardhat network sets
  `allowUnlimitedContractSize` so the full revert-string build deploys in tests)
- Deploy consensus to BSC testnet (MUST set `STRIP_REVERTS=1` — the full build is
  ~28 KB, over the EIP-170 24576-byte limit; stripping revert strings brings the
  runtime to **~24216 bytes, ~155 bytes of headroom** — tight, so weigh bytecode
  cost on any core change, and prefer the off-core sidecars/JS mirrors. The deploy
  script clean-recompiles, checks the size, requires `STRIP_REVERTS` + a
  `CONFIRM_MAINNET=1` opt-in on chainId 56, and writes `scripts/verify-args-*.js`
  from the exact ctor args so BscScan verify matches. Deploy + verify must both use
  `STRIP_REVERTS=1`):
  `cd blockchain && STRIP_REVERTS=1 npx hardhat run scripts/deploy-consensus.js --network bscTestnet`
- Taxonomy is peer-created at runtime (no seed step): a verified peer proposes a
  pillar/topic on [/evidence](src/pages/Evidence.jsx); peers endorse on the Peer
  Review Taxonomy tab until it ratifies on-chain.

## Notes for future changes

- `EvidenceConsensus` is the source of truth for peer membership, the
  Pillar → Topic taxonomy, AND every evidence/binding lifecycle. The off-chain
  `bindings` table is a projection reconciled by `chain-indexer-evidence`
  (joined to chain events by `binding_hash` = on-chain `bindingId`).
- Voting flows are per binding: `castReviewVote(id, topicId, approve)`,
  `openChallenge(id, topicId)`, `castChallengeVote(id, topicId, support)`,
  `markLapsed`/`finalizeChallenge(id, topicId)`. The off-chain writers in
  [src/evidence-data.js](src/evidence-data.js) pass `binding_id` + `topic_id` to
  `verify-attestation`; the EIP-712 `Attestation` type includes `topicId`.
- Taxonomy hashing (`node_hash` = keccak256(slug), `meta_hash` =
  keccak256(canonical JSON)) is defined by `slugToBytes32` / `computeMetaHash` in
  [src/lib/wallet-impl.js](src/lib/wallet-impl.js); the indexer joins off-chain
  rows to chain events by `node_hash`, so don't change the hashing in isolation.
- `viaIR: true` stays enabled in
  [blockchain/hardhat.config.js](blockchain/hardhat.config.js).
- **Audit-hardening invariants (keep these):**
  - *Frozen electorates.* Every accumulating peer-vote gate freezes
    `activePeerCount` at open-time and judges the tally against the snapshot, never
    the live count: review/challenge (`peerSnapshot`), taxonomy propose+reject and
    retire (`nodeSnapshot`), force-renounce (`forceRenounceSnapshot`), and the gov
    nominee/revoke gates (`nomineeSnapshot`/`revokeSnapshot`). This stops a
    peer-set shrink from lowering a bar or carrying a motion on departed peers'
    votes. (Binding-review early-expel still reads the LIVE count on purpose — it
    tests *reachability*, where growth must raise the bar.)
  - *Liveness on every act.* All signed peer acts refresh `lastActive`
    (review/challenge stamp the recovered signer; taxonomy/retire/force-renounce
    call `_touch()` for `msg.sender`), so a governance-only peer is not pruned as
    "inactive". Gov acts live in the sidecar and can't write core `lastActive`;
    `heartbeat()` is the fallback.
  - *Gov re-admission* clears any stale revocation tally (`_checkNominee`), so a
    peer removed by inactivity GC mid-motion can't be re-removed on one vote.
  - *No standalone percentage-threshold getters on the core* (`canonize`/`expel`/
    `deprecate`/`bundle`) — they were removed for EIP-170 headroom; the internal
    `_*At` helpers are the on-chain source of truth and the frontend mirrors the
    formulas in [src/evidence-data.js](src/evidence-data.js). Only
    `taxonomyThreshold()`/`retireThreshold()` remain as core getters.
  - *Signature malleability* (low-s / v) is guarded in `PeerGovernance` only;
    the core omits it deliberately (no EIP-170 room, and idempotency +
    signer-recovery already neutralize it).
  - *`EvidenceArchive.evidenceExtra` and `noteText` are UNVERIFIED* (no on-chain
    hash; permissionless writes, capped at `MAX_EXTRA_BYTES`/`MAX_NOTE_BYTES`): a
    rebuild must treat `extra` as advisory and join notes to a real vote event by
    hash before surfacing them.
- **Review outcome is order-independent:** a binding canonizes the instant approves
  reach `canonizeThreshold`; it is expelled early only once canon is arithmetically
  impossible (`canonize + rejects > activePeerCount`), else `markLapsed` resolves
  it at window close (expelled if `rejects ≥ expelThreshold`, otherwise lapsed). A
  *lapsed* (apathy) binding can be re-filed via `fileBinding` (fresh `reviewRound`);
  *expelled* / *deprecated* stay terminal.
- **Taxonomy retirement** (`motionRetireNode`/`voteRetireNode`/`cancelStaleRetire`,
  gate `retireThreshold` = ceil(2n/3)) lets peers retire a ratified **topic**
  (`NodeState.Retired`). **Pillars are never retired directly** — `motionRetireNode`
  reverts on a pillar (`"pillars auto-retire"`); instead `_checkRetire` retires the
  parent pillar automatically in the same tx when its **last** topic is retired
  (emitting a second `NodeRetired` for the pillar), so a pillar can never sit
  ratified with zero topics. The indexer flips both rows to `status='retired'`
  (each `NodeRetired` log handled independently). The retire panel lives in the
  Peer Review **Taxonomy** tab ([src/pages/PeerReview.jsx](src/pages/PeerReview.jsx)):
  topics show motion/vote/cancel; pillars show "auto-retires with its last topic".
