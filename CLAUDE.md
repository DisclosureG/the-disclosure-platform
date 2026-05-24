# Project Notes

This file is read by Claude Code on every session start. Keep it small and
authoritative — pointers to source, not duplicated content.

## On-chain archive — "Evidence"

The project runs a single smart contract on BSC. The public archive is branded
**Evidence — the Web3 Social Platform** in the UI; the on-chain contract and
the Supabase tables keep the `EvidenceConsensus` / `evidence` names.

- **`EvidenceConsensus`** — holds the canonical peer set, nominee/revoke
  governance, the **Pillar → Topic taxonomy**, and evidence records under a
  7-state lifecycle.
  - Contract: [blockchain/contracts/EvidenceConsensus.sol](blockchain/contracts/EvidenceConsensus.sol)
  - Public archive: [src/pages/Evidence.jsx](src/pages/Evidence.jsx) → `/evidence/`

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
  `endorseNode` → auto-ratify at `bundleThreshold(tier)` = max(`taxonomyThreshold()`,
  `canonizeThreshold(tier)`) so founding evidence is never canonized on a cheaper
  vote than the normal review path (proposer counts as endorsement #1). A still-pending pillar reserves its bundled topic id
  (`topicReserved`) so nothing else can claim it before ratification. The
  off-chain bundle insert is `proposeTaxonomyBundle()` in
  [src/evidence-data.js](src/evidence-data.js).
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

## Supabase

One pipeline, one registry:

| Concern | Table / function |
|---|---|
| Evidence content | `evidence` (canonical content + `content_hash`; lifecycle lives on bindings) |
| Voting unit | `bindings` (`(evidence_id, topic_id)`, per-binding status + tallies, `binding_hash`) |
| Taxonomy | `pillars` / `topics` (status proposed→ratified, joined by `node_hash`) |
| Attestations | `attestations` (one per `(binding_id, peer_addr, phase)`) |
| Chain events | `chain_events` / `chain_event_cursor` |
| Tamper alerts | `tamper_alerts` |
| Indexer edge fn | `chain-indexer-evidence` |
| Verify edge fn | `verify-attestation` |
| Audit edge fn | `audit-content-hash` |
| Atomic vote RPCs | `apply_review_counts` / `apply_challenge_counts` |
| Throttle prefixes in `edge_rate_limit` | `ev_insert:` (evidence) · `tax_insert:` (taxonomy) |

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
- `VITE_CONSENSUS_READ_RPC` (optional; falls back to MetaMask)

### Supabase edge function secrets
- `CONSENSUS_ADDR`, `CONSENSUS_RPC_URL`, `CONSENSUS_CHAIN_ID`
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
  ~27.5 KB, over the EIP-170 24576-byte limit; stripping revert strings brings the
  runtime to ~23.7 KB. The deploy script hard-fails if oversized. Deploy + BscScan
  verify must both use `STRIP_REVERTS=1` so the verified bytecode matches):
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
