# EvidenceConsensus — Explained in Plain Language

This document explains what the `EvidenceConsensus` smart contract does and how
it works, in everyday terms. It is **not** a security analysis — it just describes
the moving parts and the rules of the system.

The contract lives at
[blockchain/contracts/EvidenceConsensus.sol](contracts/EvidenceConsensus.sol).

---

## The big picture

Think of this contract as a **shared, tamper-proof logbook** for an archive of
evidence. A group of trusted members ("peers") collectively decide:

1. **What categories exist** (the filing cabinet structure).
2. **What evidence gets accepted** into those categories.
3. **Who is allowed to be a peer** in the first place.

Nothing is decided by a single boss. Almost everything happens by **voting**.
The contract only stores small fingerprints — ids, hashes, vote counts, and
status flags. The actual documents, text, and member profiles live off-chain in
a normal database (Supabase). The contract is the part that **can't be faked or
secretly edited** — the unforgeable record of "what the group agreed to."

---

## The four core ideas

### 1. Peers (the members)

A **peer** is a verified member who is allowed to vote. Peers are tracked in a
registry. The system starts with a handful of "genesis" peers set at launch, and
grows from there by members nominating and approving each other.

Each peer has a wallet address and a display name ("handle").

### 2. Taxonomy: Pillars and Topics (the filing cabinet)

Evidence has to be filed somewhere, so there's a two-level category tree:

- **Pillar** — a broad top-level category (the drawer in the filing cabinet).
- **Topic** — a sub-category that lives inside a pillar (the folder inside the
  drawer).

The tree grows **wider** (more pillars) and **deeper** (more topics) over time,
but only when peers vote to add a new category.

**Important rule: a category is never empty.** You can't create an empty pillar
or topic. When someone proposes a new pillar, they must propose it *together
with* its first topic *and* a first piece of evidence — all in one bundle. When
someone proposes a new topic, they must bundle in a first piece of evidence too.
When the group approves the bundle, the category and its founding evidence all
come into existence at the same moment.

### 3. Evidence (the content)

A piece of **evidence** is one record — a document, source, or testimony. Each
evidence has:

- A unique id.
- A **tier** (1, 2, or 3) describing how strong it is:
  - **Tier 1** — declassified / peer-reviewed (highest bar to accept).
  - **Tier 2** — documented.
  - **Tier 3** — testimonial (lowest bar).
- A **content hash** — a fingerprint of the actual document. If anyone changes
  the document even slightly, the fingerprint won't match anymore, so tampering
  is detectable.

### 4. Bindings (evidence filed under a topic)

Here's the clever part. A single piece of evidence might belong under several
topics at once. Rather than copy the evidence, the contract creates a **binding**
for each place it's filed.

> A **binding** = "this specific evidence, filed under this specific topic."

Each binding is voted on **independently**. So the same document could be
*accepted* under one topic and *rejected* under another — because relevance can
differ by category. The evidence itself stays a single record with one
fingerprint; only the bindings carry the accept/reject status.

---

## The life of a binding (the review process)

When evidence is filed under a topic, that binding goes through these stages:

```
   Submitted ──► Canon ──► Contested ──► Reaffirmed (survived) 
       │            │            └─────► Deprecated (removed)
       │            │
       ├──► Expelled (rejected by vote)
       └──► Lapsed   (ran out of time, no verdict)
```

1. **Submitted** — waiting for peers to review and vote.
2. Peers vote **approve** or **reject**:
   - Enough approvals → **Canon** (officially accepted, enters the public
     archive).
   - Once acceptance becomes mathematically impossible → it's settled early as
     either **Expelled** (clearly rejected) or **Lapsed** (just didn't get
     enough attention).
3. If the review window (30 days) closes with no verdict, anyone can finalize it,
   and it becomes Expelled or Lapsed.
4. A **Lapsed** binding can be re-filed and tried again later. **Expelled** is
   permanent.

### Challenges (re-opening an accepted record)

Even after evidence becomes **Canon**, peers can challenge it if they think it
shouldn't be there:

1. A peer **opens a challenge** → the binding becomes **Contested**.
2. Peers vote to **support** the challenge or **defend** the evidence (21-day
   window).
3. Outcome:
   - Enough support → **Deprecated** (removed from the archive).
   - Otherwise, when the window closes → **Reaffirmed** (it stays, now confirmed
     a second time).

There are cooldowns so the same evidence can't be challenged over and over to
keep it in limbo, and so a single peer can't spam challenges.

---

## How new things get added (the voting flows)

Everything below is decided by peers voting. The proposer always counts as the
first "yes."

### Adding a peer (nomination)

1. A current peer **nominates** a new wallet address (with a handle).
2. Other peers **endorse** the nominee.
3. When endorsements reach the threshold, the nominee automatically becomes an
   active peer.
4. If a nomination never gets enough support within the window, anyone can clear
   it so the address can be tried again later.

### Removing a peer (revocation)

1. A peer **opens a motion** to remove another peer.
2. Peers **vote** on it.
3. When votes reach a majority, the peer is removed.
4. A stale motion that never passed can be cleared after its window.

### Adding a category + founding evidence (taxonomy proposal)

1. A peer **proposes** a pillar (bundled with a first topic + first evidence) or
   a topic (bundled with a first evidence).
2. Peers **endorse** the proposal.
3. When endorsements reach the bundle threshold, everything ratifies at once: the
   category appears and the founding evidence is accepted as Canon.
4. A proposal that never passes within the window can be cleared, freeing up the
   reserved ids.

### Retiring a category (taxonomy retirement)

Categories are never deleted (the log is permanent), but a strong supermajority
of peers can **retire** a pillar or topic so it drops out of the public lists.
A pillar can only be retired once all its topics are retired first (so no topic
is left orphaned).

---

## How votes are counted (thresholds in plain terms)

Different decisions need different levels of agreement. The numbers scale with
how many active peers there are:

| Decision | Roughly how much agreement is needed |
|---|---|
| Accept evidence (canonize) | A true majority — 60% (tier 1), 55% (tier 2), 51% (tier 3) |
| Reject evidence (expel) | About 25% reject it |
| Remove accepted evidence (deprecate) | A bigger majority — 65% / 60% / 55% by tier |
| Admit / approve a category proposal | More than one third (admission) / a strict majority (ratify a category) |
| Remove a peer (revoke) | A simple majority |
| Retire a category | A strong two-thirds supermajority |

Higher-tier (stronger) evidence needs **more** agreement to get in and is
**harder** to remove — the bar matches how authoritative the record claims to be.

A neat property: the outcome of a review **doesn't depend on the order** votes
arrive in. Evidence becomes Canon the instant approvals hit the bar, and is only
rejected early once acceptance is genuinely impossible. To keep this fair while
the membership changes, each review "freezes" the peer count from when it started
as its yardstick.

---

## Ownership and emergency controls

There is an **owner** role, but its powers are deliberately tiny and temporary:

- **Pause / unpause** the contract in an emergency.
- **Seed peers** — but *only* during the early startup phase, before the network
  is big enough to govern itself.

That's it. The owner **cannot** force evidence in, force peers out, or override
votes. Once the network is up and running, the owner can **renounce** the role
entirely, leaving the system fully community-governed.

There's also a backstop: if the owner ever misbehaves (e.g. pauses forever), a
two-thirds supermajority of peers can vote to **strip the owner** and unpause the
contract themselves. Ownership can also be handed over in a safe two-step
"propose then accept" process.

---

## Why off-chain + on-chain together

- **On-chain (this contract):** ids, hashes, vote tallies, and statuses. Small,
  permanent, and impossible to secretly alter.
- **Off-chain (Supabase):** the full documents, text, and peer profiles, plus an
  indexer that mirrors the contract's events into a database for fast browsing.

Anyone can check that the off-chain content still matches the on-chain
fingerprint, so the readable archive and the unforgeable log always agree.

---

## One-line summary

> A community of verified peers collectively builds a tamper-proof, voted-on
> archive: they decide the categories, file evidence under them, and approve,
> reject, challenge, or retire records — all by transparent on-chain voting, with
> no single authority in control.
