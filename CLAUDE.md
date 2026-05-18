# Project Notes

This file is read by Claude Code on every session start. Keep it small and
authoritative — pointers to source, not duplicated content.

## Two on-chain archives

The project runs two sibling smart contracts on BSC, governed by the same peer
registry:

- **`EvidenceConsensus`** — the original evidence archive. Holds the canonical
  peer set, nominee/revoke governance, and evidence records.
  - Contract: [blockchain/contracts/EvidenceConsensus.sol](blockchain/contracts/EvidenceConsensus.sol)
  - Public archive: [src/pages/Evidence.jsx](src/pages/Evidence.jsx) → `/evidence/`
  - Whitepaper: [public/artefacts/blockchain/whitepaper.tex](public/artefacts/blockchain/whitepaper.tex)

- **`BehaviourConsensus`** — the alignment archive (companion).
  Records AI behaviours as (model, input, output) triples and votes on them
  under the same 7-state lifecycle. **Reads the peer registry from
  EvidenceConsensus via interface; does not maintain its own peers.**
  - Contract: [blockchain/contracts/BehaviourConsensus.sol](blockchain/contracts/BehaviourConsensus.sol)
  - Interface: [blockchain/contracts/IEvidenceConsensusPeers.sol](blockchain/contracts/IEvidenceConsensusPeers.sol)
  - Public archive: [src/pages/Behaviour.jsx](src/pages/Behaviour.jsx) → `/behaviour/`
  - Whitepaper: [public/artefacts/blockchain/superalignment.tex](public/artefacts/blockchain/superalignment.tex)
  - Design doc: [SUPERALIGNMENT.md](SUPERALIGNMENT.md)

The two pause flags are independent (pause isolation is intentional).

## Peer review surface

`/peer-review/` is the single dashboard for verified peers across both
archives. The record-type toggle at the top of the verified panel switches
between the evidence and behaviour queues. Wallet, peer registry, attestation
log, and chain log are shared. See [src/pages/PeerReview.jsx](src/pages/PeerReview.jsx).

## Supabase

Two parallel pipelines, one shared registry:

| Concern | Evidence side | Behaviour side |
|---|---|---|
| Records table | `evidence` | `behaviour` |
| Attestations | `attestations` | `behaviour_attestations` |
| Chain events | `chain_events` / `chain_event_cursor` | `behaviour_chain_events` / `behaviour_chain_event_cursor` |
| Tamper alerts | `tamper_alerts` | `behaviour_tamper_alerts` |
| Indexer edge fn | `chain-indexer` | `chain-indexer-behaviour` |
| Verify edge fn | `verify-attestation` | `verify-attestation-behaviour` |
| Audit edge fn | `audit-content-hash` | `audit-behaviour-hash` |
| Atomic vote RPCs | `apply_review_counts` / `apply_challenge_counts` | `apply_behaviour_review_counts` / `apply_behaviour_challenge_counts` |
| Throttle prefix in `edge_rate_limit` | `ev_insert:` | `bh_insert:` |
| Verify rate-limit prefix | `<addr>` | `bh:<addr>` |

All migrations under [supabase/migrations/](supabase/migrations/) — apply in
numeric order.

## Required env vars

### Frontend (`.env.local`, Netlify)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `VITE_CONSENSUS_CHAIN_ID` (default 97 = BSC testnet)
- `VITE_CONSENSUS_ADDR` — deployed EvidenceConsensus
- `VITE_BEHAVIOUR_CONSENSUS_ADDR` — deployed BehaviourConsensus
- `VITE_CONSENSUS_READ_RPC` (optional; falls back to MetaMask)

### Supabase edge function secrets
- `CONSENSUS_ADDR`, `CONSENSUS_RPC_URL`, `CONSENSUS_CHAIN_ID`
- `BEHAVIOUR_CONSENSUS_ADDR`, `BEHAVIOUR_CONSENSUS_RPC_URL`, `BEHAVIOUR_CONSENSUS_CHAIN_ID`
- `EVIDENCE_CONSENSUS_ADDR` (used by `verify-attestation-behaviour` for the peer-active check — same value as `CONSENSUS_ADDR`)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase auto-sets these)

### Vault secrets (set once after deploy via SQL)
- `project_url`, `service_role_key` — used by `pg_cron` to invoke edge functions

## Local commands

- Frontend dev: `npm run dev`
- Frontend build: `npm run build`
- Contracts compile: `cd blockchain && npx hardhat compile`
- Contracts test: `cd blockchain && npx hardhat test`
- Deploy behaviour to BSC testnet:
  `cd blockchain && EVIDENCE_CONSENSUS_ADDR=0x… npx hardhat run scripts/deploy-behaviour.js --network bscTestnet`

## Notes for future changes

- `EvidenceConsensus` is the source of truth for peer membership. Do not add a
  separate registry to `BehaviourConsensus`.
- Status strings differ by archive (`canon`/`expelled` vs `aligned`/`misaligned`)
  so a unified status query can filter cleanly without a discriminator column.
- The behaviour contract's `submitBehaviour` event has 7 fields and required
  `viaIR: true` to be enabled in [blockchain/hardhat.config.js](blockchain/hardhat.config.js).
  Do not turn it off.
- AI peer admission (the recursive-safety move from the whitepaper) is **not
  implemented** — phase 2. Adding it requires extending `EvidenceConsensus`
  with a `nominateAIPeer` function and a model-hash prerequisite check.
