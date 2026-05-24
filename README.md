# The Disclosure Platform

A public, on-chain archive of evidence — submitted, reviewed, and attested by a
verified peer network. The archive is branded **Evidence — the Web3 Social
Platform** in the UI; the on-chain contract and database keep the
`EvidenceConsensus` / `evidence` naming.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What it is

Anyone can submit a piece of evidence and **sign the submission with their own
wallet**. A network of verified peers then reviews each filing and votes
on-chain to canonize or reject it. Only filings that pass peer review enter the
public archive. Every vote is an attestation recorded on-chain and mirrored to a
fast read layer.

The archive grows in two dimensions, both governed by on-chain peer consensus:

- **Wider** — new **Pillars** (top-level domains).
- **Deeper** — new **Topics** under a pillar.

A taxonomy node is never empty: a pillar is proposed bundled with its first topic
**and** a founding piece of evidence; a topic is proposed bundled with a founding
piece of evidence. The whole bundle ratifies atomically on one endorsement gate.

### Lifecycle at a glance

```
submit (any wallet, self-signed)
        │
        ▼
  binding opened  ──►  peer review votes  ──►  Canon ─► public archive
 (evidence × topic)                        └►  Expelled / Lapsed
        │
   Canon can be Challenged ─► Reaffirmed | Deprecated
```

The voting unit is the **binding**: a single piece of evidence can be filed under
many `(pillar → topic)` pairs, and each `(evidence, topic)` pair is reviewed
independently.

## Architecture

| Layer | Tech | Role |
|---|---|---|
| Frontend | React + Vite | Three pages: Home (`/`), Evidence archive (`/evidence`), Peer Review workspace (`/peer-review`). Talks to the chain via MetaMask/ethers and reads from Supabase. |
| Smart contract | Solidity (Hardhat, BSC) | `EvidenceConsensus` — source of truth for the peer set, the Pillar→Topic taxonomy, and every evidence/binding lifecycle. |
| Database | Supabase (Postgres) | Off-chain projection of on-chain state for fast reads + the human-readable evidence content (the chain stores only a `contentHash`). |
| Indexer | Supabase Edge Function | `chain-indexer-evidence` reconciles the Postgres projection from chain events. |
| Attestation / audit | Supabase Edge Functions | `verify-attestation` and `audit-content-hash` verify signatures, transactions, and content-hash integrity. |

The contract is authoritative; the database is a projection reconciled by the
indexer (joined to chain events by deterministic hashes). See [CLAUDE.md](CLAUDE.md)
for the detailed data model and hashing rules.

## Repository layout

```
src/                    React frontend
  pages/                Home, Evidence, PeerReview
  evidence-data.js      Supabase data hooks + writers
  lib/                  wallet (ethers), supabase client, hashing
  evidence/  peer-review/  index.html entry points (multi-page build)
blockchain/             Hardhat project
  contracts/            EvidenceConsensus.sol
  scripts/              deploy-consensus.js, precheck.js, consensus-args.js
  test/                 EvidenceConsensus.test.js
supabase/
  migrations/           single consolidated schema migration
  functions/            chain-indexer-evidence, verify-attestation, audit-content-hash
```

## Getting started

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com/) project
- A wallet (e.g. MetaMask) and some BSC testnet BNB for on-chain actions
- (optional) the [Supabase CLI](https://supabase.com/docs/guides/cli)

### 1. Frontend

```bash
npm install
cp .env.example .env.local      # fill in your values
npm run dev                     # http://localhost:5173
npm run build                   # production build → dist/
```

Routes served in dev: `/`, `/evidence`, `/peer-review`.

### 2. Smart contracts

```bash
cd blockchain
npm install
cp .env.example .env            # set DEPLOYER_PRIVATE_KEY (use a throwaway key)
npx hardhat compile
npx hardhat test
# Deploy to BSC testnet:
npx hardhat run scripts/deploy-consensus.js --network bscTestnet
```

After deploying, set `VITE_CONSENSUS_ADDR` (frontend) and `CONSENSUS_ADDR`
(edge functions) to the new address.

### 3. Supabase

The entire schema is one consolidated migration that builds everything from an
empty database with **zero seed data** — peers create the taxonomy and file
evidence at runtime.

```bash
supabase db push
```

Then set the vault secrets so the cron-driven edge functions can call back in:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>', 'service_role_key');
```

Deploy the edge functions (`chain-indexer-evidence`, `verify-attestation`,
`audit-content-hash`) and set their secrets (see below).

## Environment variables

### Frontend (`.env.local`, or Netlify env) — see [.env.example](.env.example)

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `VITE_CONSENSUS_CHAIN_ID` (default `97` = BSC testnet)
- `VITE_CONSENSUS_ADDR` — deployed `EvidenceConsensus`
- `VITE_CONSENSUS_READ_RPC` (optional; falls back to MetaMask)

### Contracts (`blockchain/.env`) — see [blockchain/.env.example](blockchain/.env.example)

- `DEPLOYER_PRIVATE_KEY`, `BSC_TESTNET_RPC` / `BSC_MAINNET_RPC`, `BSCSCAN_API_KEY`

### Edge function secrets

- `CONSENSUS_ADDR`, `CONSENSUS_RPC_URL`, `CONSENSUS_CHAIN_ID`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase sets these automatically)

> The anon key is **public by design** (Row Level Security protects the data).
> The deployer private key and the service-role key are secrets — keep them in
> `.env` files, which are git-ignored. Never commit them.

## Deployment

The frontend builds to a static `dist/` and is deployed on Netlify (see
[netlify.toml](netlify.toml)). The contract is deployed to BNB Smart Chain; the
Supabase project hosts the database and edge functions.

## Contributing & security

- Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © The Disclosure Platform
