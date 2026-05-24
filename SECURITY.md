# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via GitHub's
[Security Advisories](https://github.com/DisclosureG/the-disclosure-platform/security/advisories/new)
("Report a vulnerability"), or by email to the maintainer listed on the GitHub
profile.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept where possible).
- The affected component: frontend, smart contract, or Supabase edge function.

We will acknowledge your report as soon as possible and keep you updated on the
fix. Please give us a reasonable window to address the issue before any public
disclosure.

## Scope

This project spans three trust boundaries — all are in scope:

- **Smart contract** (`blockchain/contracts/EvidenceConsensus.sol`) — peer
  governance, taxonomy, and the evidence/binding lifecycle. This is the source
  of truth.
- **Frontend** (`src/`) — wallet interactions, signing flows, and what is shown
  to users.
- **Supabase edge functions** (`supabase/functions/`) — signature/transaction
  verification (`verify-attestation`), the chain indexer
  (`chain-indexer-evidence`), and content-hash auditing (`audit-content-hash`).

Particularly valuable reports include: bypasses of on-chain access control or
review thresholds, signature/replay or content-hash forgery, RLS bypasses, and
indexer reconciliation flaws that let the off-chain projection diverge from the
chain.

## Threat model & consensus thresholds

The contract assumes a **BFT-style honest supermajority (honest > 2/3)**. Under that
assumption every governance and review outcome is reachable by the honest set and
unreachable by any coalition of ≤ 1/3 of peers. The thresholds, all computed live
from `activePeerCount`:

| Action | Gate |
|---|---|
| Peer admission (`nomineeThreshold`) | `floor(n/3)+1` — strictly > 1/3 (the capture boundary) |
| Peer revocation (`revokeThreshold`) | `ceil(n/2)` — simple majority |
| Canonize a binding (`canonizeThreshold`) | **true majority** — tier1 60 % / tier2 55 % / tier3 51 % |
| Expel at window close (`expelThreshold`) | 25 % of rejections |
| Deprecate via challenge (`deprecateThreshold`) | tier1 65 % / tier2 60 % / tier3 55 % |
| Ratify taxonomy (`taxonomyThreshold`/`bundleThreshold`) | **strict majority** `floor(n/2)+1`, decoupled from admission |
| Retire taxonomy (`retireThreshold`) | `ceil(2n/3)` supermajority |
| Force-renounce the owner | `ceil(2n/3)` supermajority |

Notes on the design:

- **Canon is a majority, not a minority.** Canonization requires > 50 % of peers, so
  "Canon" reflects majority consensus. Early-canonization still fires the instant the
  majority bar is met (legitimate fast finality), and remains mutually exclusive with
  "canon arithmetically impossible," so the review verdict is order-independent.
- **Taxonomy creation needs a majority**, decoupled from the 1/3+1 admission gate.
  This narrows the create-vs-retire gap (now ~1/2 → 2/3): a sub-majority faction can
  no longer cheaply spawn nodes that a 2/3 supermajority must then clean up.
- **The owner is not a permanent trust assumption.** The owner's only powers are
  pause and seed-phase `addPeer`, and a `ceil(2n/3)` peer supermajority can
  `motionForceRenounce` / `voteForceRenounce` to strip the owner entirely and
  unpause — so a captured owner cannot brick the network. After the seed phase the
  owner can also `renounceOwnership` voluntarily.

## Known residual risks (accepted by design)

- **Ghost votes.** Each binding snapshots `activePeerCount` at review/challenge open
  (`peerSnapshot`), so the *threshold* is immune to mid-window membership churn. The
  snapshot does **not** retract a vote already cast by a peer who is later revoked —
  full voter-set snapshotting is too expensive for the EIP-170 bytecode budget and is
  not exploitable under the honest-majority assumption (a ≤ 1/3 coalition cannot
  change `n`).
- **Open-submission front-running.** `submitEvidence` is permissionless, so an
  evidence id is visible in the mempool before it confirms; an adversary can bind an
  id to junk content. Bounded by `audit-content-hash`, free UUID re-mint, and the fact
  that nothing enters the public archive without passing peer review. See the contract
  header for the full discussion.
- **Governance/submission spam** is bounded on-chain by `pendingSubmissions`
  (per-submitter outstanding bindings) and `pendingProposals` (per-peer outstanding
  taxonomy proposals), enforced even when a peer bypasses the off-chain rate limits.

## Secrets handling

- The Supabase **anon key** is public by design; Row Level Security protects the
  data. Do not report its presence in the built frontend as a vulnerability.
- The contract **deployer private key** and the Supabase **service-role key** are
  secrets and live only in git-ignored `.env` files. If you ever find one
  committed to the repository or its history, report it immediately.
