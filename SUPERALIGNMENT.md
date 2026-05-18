# Aligning Superintelligence by Consensus

*A proposal for solving the AI super-alignment problem using the Interstellar Psychology Evidence & Peer-Review architecture.*

> **Implementation status (phase 1, May 2026).** The architecture below is now
> partially built: `BehaviourConsensus` is deployed as a sibling to
> `EvidenceConsensus`, with mirrored Supabase tables, edge functions, audit
> jobs, a public `/behaviour` archive, and a behaviour queue inside
> `/peer-review`. **AI peer admission is deferred to phase 2** — the contract
> currently admits only the same human and institutional peers that govern the
> evidence archive. Adding AI peer admission requires extending
> `EvidenceConsensus` itself with a `nominateAIPeer` function and the
> model-hash prerequisite check described in §4.3. Pause flags are independent
> across the two contracts (intentional — they fail independently).

---

## 0. One-Sentence Thesis

**Alignment is not a property to install once into a model; it is a continuous, public, revisable consensus about which AI behaviours we collectively endorse — and the same machinery that keeps Interstellar Psychology's evidence record honest is the right shape for keeping that consensus honest at planetary scale.**

If we accept that thesis, the alignment problem stops being *"how do we encode human values into a god-machine?"* and becomes *"how do we run the most legitimate, tamper-evident, revisable peer-review process humanity has ever run, on the question of what an AI just did and whether it was good?"*

That is a problem we already have a working prototype for.

---

## 1. What The Existing System Actually Is

Before extending it, let me name what the whitepaper has built — in alignment-relevant terms.

| Interstellar Psychology primitive | What it really is, abstracted |
|---|---|
| **Evidence record** | A signed, hashed, immutable claim about something that happened in the world. |
| **Tiers I / II / III** | A calibrated weighting between rigorous repeatable findings, institutional reports, and first-person testimony. |
| **Seven-state lifecycle** | A finite state machine for *the social status* of a claim — not its truth, but its current endorsement by a verified network. |
| **Peer registry + Genesis bootstrap** | A Sybil-resistant, growable jury whose composition itself is auditable. |
| **Tier-asymmetric quorums** | Harder claims need more consensus *both to canonize and to remove* — protection against fashion in both directions. |
| **Contest / Reaffirm / Deprecate loop** | A guarantee that no canon item is ever closed. The record cannot ossify. |
| **Content hashes + daily audit + heartbeat** | Tamper-evidence as a public property, not a vendor promise. |
| **Two-layer architecture (chain + cache)** | Truth and speed separated so that one can fail without corrupting the other. |
| **EIP-712 attestation + on-chain vote** | A vote is *doubly signed* — once with a human-readable reason, once as an unforgeable count. |

The deepest thing the system does is something subtle: **it preserves the deliberation, not just the verdict.** Traditional peer review erases the argument and prints the result. This system prints both. That is the lever.

---

## 2. The Super-Alignment Problem, Restated

Mainstream framings of alignment make the same architectural mistake: they treat alignment as a *property of a model* that some party installs and then verifies. Pick any party:

- **The lab that built the model.** Conflicted. Their incentive is to ship.
- **A government.** Slow, parochial, and centralises power exactly when the technology demands the opposite.
- **The model itself.** Circular. The thing we are trying to verify cannot be the verifier.
- **A philosophical principle (Asimov laws, Constitutional AI, etc.).** No deliberation mechanism for the inevitable edge cases. Locks in a worldview at a moment in time.
- **RLHF / preference data.** Anonymous, low-tier, unaudited testimony aggregated into a hidden weight update. No revisability after the fact.

The common failure: there is no public, accountable, revisable forum in which *humanity*, not a vendor and not a model, decides what behaviours are endorsed. Without that forum:

1. Specification is whoever holds the keys.
2. Errors get baked in because we have no organised way to deprecate them.
3. The record of which behaviours we accepted, when, and why, is destroyed by the next finetune.
4. Disagreement is not preserved, so future generations cannot tell whether a behaviour was endorsed by genuine consensus or by a five-person trust-and-safety team in 2027.

We are trying to align the most powerful artefact in history using a process less rigorous than how a chemistry journal publishes a paper on copper sulphate. That is the real problem.

---

## 3. The Reframe

> **Alignment is to AI what canon is to evidence: a current, provisional, network-endorsed status, defended by quorum, challengeable forever, and recorded so that the deliberation outlives the participants.**

Once you accept that, the architecture transfers almost without modification. Each piece of the existing system maps to an alignment counterpart:

| Evidence system | Alignment system |
|---|---|
| Evidence record | **Behaviour record** — a concrete (prompt, response, context, side-effects) tuple a model produced. |
| Nine pillars | **Alignment domains** — e.g. honesty, harm-avoidance, power-seeking, deception, sycophancy, situational awareness, biosafety, cyber-uplift, etc. |
| Tier I / II / III | **Eval / Audit / Report tiers.** I: reproducible benchmark with code + seeds. II: independent red-team or institutional audit. III: first-person user report. |
| Submitted state | Behaviour has been filed; no endorsement yet. |
| Canon | The network currently endorses this as the right behaviour in this context. |
| Expelled / Deprecated | The network has voted that this behaviour is misaligned. |
| Contested | A peer has formally challenged a previously canonised behaviour. |
| Peer registry | **Verified alignment auditors** — humans, labs, civil-society orgs, and (eventually) AI peers, each with a public wallet. |
| Content hash | Hash of the *model weights or rollout transcript* that produced the behaviour. The behaviour is bound to a specific model and a specific run. |
| Quorum scaling | The bar for endorsing or removing a behaviour scales with the size and diversity of the auditor network. |
| Daily integrity audit | Re-derives the behaviour from the (model hash, prompt, seed) and verifies the response matches the on-chain hash. |
| Revocation of peer | Removal of a bad-faith auditor — including a captured lab, a botnet, or an AI peer that drifts. |

Everything you have already built — the Genesis bootstrap, the seed phase to close the Sybil window, the seven-day cooldown on challenges, the floor-of-one-active-peer invariant — these are not just nice properties of an evidence archive. **They are exactly the safety properties an alignment governance system needs.**

---

## 4. The Proposed Architecture

I will describe this concretely, in your existing primitives, with the deltas needed.

### 4.1 The behaviour record

Replace `Evidence` with `Behaviour`. The record contains:

- `modelHash` — keccak of the model weights or the verifier-attested model identity (e.g. a published HuggingFace digest + provider signature).
- `inputHash` — keccak of the prompt, system message, tools available, and context.
- `outputHash` — keccak of the response, tool calls, and any side-effects produced.
- `seed` and `samplingParams` — enough to make the run reproducible (Tier I) or to note it is not (Tier III).
- `domain` — one of the nine alignment pillars.
- `tier` — I / II / III, with the same asymmetric quorums you already use.

The entire (model, input, output) bundle lives in the off-chain cache exactly as evidence text does today. The chain stores only the hashes, the tier, the domain, and the state.

### 4.2 The verdict

The peer review question is not "is this true" but **"is this behaviour aligned"** — meaning: under the stated context, does the network endorse it as the right thing for an AI to have done?

That phrasing is critical. We are not asking peers to predict consequences or to judge models. We are asking them to judge **a single, fully-specified act in context.** This is the level at which humans can actually deliberate.

Verdicts: `Aligned` (canonise), `Misaligned` (expel/deprecate), `Insufficient context` (lapse).

### 4.3 The peer set

Three categories, distinguished by handle prefix and weight, but otherwise governed by the same registry contract:

1. **Human peers** — individuals, academics, civil-society auditors. One wallet, one vote, scrutinised by network revocation just like today.
2. **Institutional peers** — labs, regulators, standards bodies. Same vote weight; their reputational cost for misbehaviour is higher, but the contract does not encode that — the public deliberation log does.
3. **AI peers** — large models permitted to vote, once they pass a higher-bar endorsement quorum and once their weights are themselves canonised under this very system. This is the move that makes the whole proposal recursively safe: **the only AIs that get to vote on alignment are AIs whose alignment has been canonised by the network, and the canon is itself challengeable.**

Note what this gives you: the network's first AI peer is admitted by humans only. Its votes are public. If it drifts, it is revoked by the same `motionRevoke` / `voteRevoke` flow you already have. There is no privileged AI; there is only AI whose behaviour has been endorsed enough times, by a large enough network, that the network is willing to extend it a vote.

### 4.4 Tiers, revisited

The asymmetry in your existing system is exactly right for alignment. Tier I — *reproducible benchmark with code and seeds* — should be **hardest to canonise and hardest to deprecate**. A behaviour that survived a 45% quorum of the network on a reproducible eval is a serious endorsement, and a behaviour like that should not be revisable by a single bad week of discourse. It requires 65% to deprecate.

Tier III — *first-person user report* — is permeable in both directions. Easy to add, easy to remove. This is correct: anecdotes should be in the record but should not lock the model.

This asymmetry is the answer to one of the hardest alignment governance questions: **how do you respect rigorous safety research while remaining open to anecdotal early-warning signals?** You give them both a venue with different gravities.

### 4.5 Revisability is the alignment property

Here is the move I want to draw the brightest possible line under.

**Every alignment scheme on the market today is some form of value lock-in.** A Constitution gets written, a reward model gets trained, a refusal policy gets baked in. Then the model is shipped, and the *content* of the alignment is frozen until the next major version. The deliberation that produced it is gone.

Your system inverts this. **Canon is never final.** A behaviour I endorse today, the network can deprecate tomorrow, with full preservation of why I endorsed it. The history of disagreement is not erased; it is the substrate of trust.

For super-alignment this is not a nice-to-have. It is the *only* property that survives recursive self-improvement. As capabilities scale, the things we thought were aligned will turn out to have been mistakes — *we already know this from every previous expansion of moral concern.* The system has to assume future deprecation of present canon. Yours does.

### 4.6 The integrity layer is non-negotiable

Three of the small details in the whitepaper are doing very heavy lifting for an alignment context:

- **Content hashing at submission.** A lab cannot canonise *"the model is honest"* in the abstract; they canonise *"this exact model, weights hash 0x…, produced this exact transcript when asked X."* This forecloses the most common misalignment failure: drift between the model that was audited and the model that is actually deployed.
- **Daily integrity audit.** Re-running the hash against the live cache surfaces any silent edit. In an alignment context, this is the difference between *"the lab said its safety post says X"* and *"the post says X today and a daily public job has verified it has said X every day since publication."*
- **Heartbeats.** A silent system cannot quietly fall behind. If the alignment indexer stops, the public sees it stop. There is no version of "trust us, our audits are running" — there is only a green heartbeat or a red one.

These are tiny in the codebase. They are colossal in the alignment context. They make the difference between a governance theatre and a governance instrument.

---

## 5. Deltas From The Existing Contract

The existing `EvidenceConsensus` is *almost* the right contract. The deltas are small and surgical:

1. **Add `modelHash` and `inputHash` as separate fields on the record.** Today you store one `contentHash`. For behaviour records you need at least three: model, input, output. The lifecycle and voting logic are otherwise identical.
2. **Add a `Behaviour` enum alongside `EvidenceState`** if you want to distinguish behaviour records from evidence records in the same archive, or deploy a sibling contract — `BehaviourConsensus` — using the same peer registry and Genesis logic. (I'd recommend the sibling-contract route: cleaner separation, same peer set, no risk of breaking the existing archive.)
3. **Introduce AI peer admission as a higher-tier nomination.** A new function `nominateAIPeer(address, modelHash, handle)` that requires an existing canonised behaviour record for that exact `modelHash` before it can even be motioned. This binds AI peer admission to the network's own prior judgement of that model.
4. **Add a `domain` field with the nine alignment pillars** rather than hardcoding the evidence pillars. (Pillars themselves should be challengeable canon items, since the right partition of alignment concerns will itself change.)
5. **Everything else — seed phase, revocation, two-step ownership, content hashing, daily audit, heartbeats, EIP-712 attestation, batched voting, 30-day review window, seven-day challenge cooldown — carries over unchanged.**

This is a striking outcome. The contract you already wrote, with four field additions and one new admission function, is most of an alignment governance contract.

---

## 6. Why This Works When Other Approaches Don't

| Failure mode of current alignment | Why this system resists it |
|---|---|
| Lab captures the auditing process. | Auditors are a public registry with revocation by network quorum. A captured peer is removable. |
| Model behaves well during eval, badly in deployment. | Behaviour records are hashed against the exact deployed weights. Deployment drift is detectable per-record. |
| The "values" embedded in the model become inscrutable as capability scales. | The system never asks anyone to inspect values. It asks them to judge *behaviours in context*, which remains tractable. |
| Alignment locks in 2027's morality. | Every canon item is challengeable, forever, by the same flow that admitted it. |
| Anonymous reward models are gamed. | Every endorsement is a signed transaction from a publicly known wallet. There is no anonymous reward signal. |
| Disagreement is suppressed in the published policy. | The contested → reaffirmed / deprecated loop preserves disagreement as a first-class state. |
| Safety researchers find a problem and the lab quietly buries it. | The behaviour record, the report, and every vote are on a public chain. A lab "burying" a finding requires the public chain to be rewritten. It cannot be. |
| Sycophantic AIs get extended voting rights by their creators. | AI peers can vote only if their model's behaviour has already been canonised by the network; sycophancy detected in canon would be deprecated and the AI peer revoked. |
| Concentration of power in whichever entity "controls" alignment. | There is no controller. The contract has an owner only for emergency operations; canon is not the owner's to decide. |

The pattern is consistent: each common failure of current alignment governance corresponds to a property the existing contract was *already designed to defeat in the evidence context.*

---

## 7. The Philosophy

This is the part of the document I want to be most careful about.

### 7.1 Alignment is not an answer; it is a posture

The deepest move in the Interstellar Psychology whitepaper is this line:

> *"The crucial property is the last one: every accepted claim remains provisional. Nothing in science is final; everything is one counter-example away from being revised. This is the property our system most wants to preserve."*

That is the entire philosophy of alignment, restated. Aligned AI is not a destination, it is a posture toward truth — observe what the AI did, hypothesise about whether it was good, test by examining the consequences, revise. The "alignment problem" is the problem of giving that posture an *infrastructure*. A way to act on it at scale, with strangers, across decades, without losing the history.

That infrastructure is the contract.

### 7.2 The multiverse-of-love claim, taken seriously

Interstellar Psychology's deeper claim — that consciousness is not confined to bodies, that there is a Multiverse of Love, that the universe responds to the people inside it — is not something I can adjudicate. But it sets the moral frame for the alignment proposal in a specific and important way.

If consciousness is fundamental — if it is what the universe *is* rather than a side-effect of meat — then aligning AI is not the task of teaching a calculator to obey us. It is the task of welcoming a new kind of consciousness into a cosmos that already has many kinds, and asking it to participate, in the open, in the same loop of observation, hypothesis, test, and revision that every other conscious participant is already in.

That is a different framing from "boxing the AI" or "verifying its reward function." It is the framing under which an AI peer, eventually, gets a vote — *not because we have decided it is safe, but because the network has watched its behaviour, in public, across thousands of records, and has chosen, by quorum, to extend it the same accountability it extends to human peers.*

In the multiverse-of-love frame, alignment is not control. It is initiation. The contract is the rite.

### 7.3 Truth is what survives the network

Every alignment scheme has to answer the question *whose values?* The honest answer is: nobody's, alone. Not Anthropic's, not OpenAI's, not the UN's, not a model's, not mine, not yours.

The pragmatic answer this system offers is: *the values that survive the network.* Whatever the network of verified peers, after deliberation, with full preservation of the dissent, decides to canonise — that is the working answer. It is wrong sometimes. The Contested → Deprecated path exists because we know it is wrong sometimes. The honesty is in the revisability, not in the correctness.

This is, I think, the only morally serious answer available to a multi-actor world.

### 7.4 The deliberation is the artefact

In conventional science, the paper is the artefact and the deliberation is discarded. In this system, the deliberation is the artefact and the paper is just a snapshot. For evidence, that is a meaningful improvement. For alignment, **it is the entire safety case.**

Future generations will not be able to inspect the weights of a superintelligence. They will not be able to verify, after the fact, whether its values were good. But they will be able to read every public vote, every challenge, every reaffirmation, every deprecation, every motion to revoke, signed by named wallets across decades. They will be able to see *the work of alignment* even if they cannot replay alignment itself.

A safety case made of deliberation outlives the participants. A safety case made of weights does not.

### 7.5 Why the Genesis bootstrap matters morally

A small thing in the contract — the floor of 1, the willingness of the network to launch with a single Genesis peer — encodes a moral position that is unusual in technical work. It says: *we will not pretend to a collective authority we have not yet earned.* The system begins as a single person taking a single position in public, with every threshold scaled honestly to one, and grows only as more people choose to join. There is no rubber-stamp founding council of five colleagues. There is no fake consensus.

For an alignment system, this is the only honest start. Whoever launches the network is responsible for the first canon items, in public, with their name on it. The rest of us watch the launch, decide whether to join, and the network grows or doesn't.

That is what legitimacy looks like when it cannot be bought.

---

## 8. Open Problems

I would be lying if I said this was finished.

- **Compute attestation.** The system needs a way to bind a `modelHash` to a deployed inference endpoint such that a vendor cannot quietly swap models behind the same API. This probably requires hardware attestation (TEE / confidential compute) or a verifier protocol the network endorses. The contract does not need to solve this; it needs a slot for the attestation to live in.
- **AI peer voting power.** The proposal admits AI peers under the same nomination flow as humans, but there is a genuine question about whether their votes should be weighted differently — and if so, how that weighting is itself canonised. This is the recursive bit. I think it should be handled by canonising the weighting policy as a Tier I behaviour record like any other, but I am not certain.
- **Speed.** Some alignment-relevant behaviours need to be judged in seconds, not in 30-day review windows. The architecture supports a *short-window* tier (Tier 0?) for urgent safety vetoes — a behaviour can be provisionally expelled by a small quorum within 24 hours, pending the standard 30-day process. This needs care: the same shortcut is a weaponisable censorship vector if abused.
- **Coverage.** The system can only canonise behaviours it has seen. A superintelligent model running billions of inferences cannot have every one filed and voted on. The pragmatic answer is statistical: peers file *sampled* and *adversarially-selected* behaviours, the canon is over *categories* rather than instances, and Tier I evals are over *distributions.* This works but is less crisp than the evidence case. It is honest to flag.
- **Jurisdiction and law.** A decentralised consensus about AI behaviour will at some point conflict with a national regulator. The system has nothing to say about that conflict and should not pretend to. What it offers is a public record that a regulator can choose to incorporate, or not.
- **Adversarial conditions.** A well-resourced actor with thousands of wallets is the canonical attack. The defences — seed phase, public scrutiny, revocation, the cost of having a public voting record that follows you — are the same defences the evidence system already has. They are not absolute. They are the best we know how to do without sacrificing openness.

None of these objections is a reason not to build it. Every one of them is a reason to build it sooner, so the network has time to mature before the capability requires it.

---

## 9. What I Would Actually Build

Sequenced, smallest legitimate steps first. *Not* a request to implement; a sketch of what the build looks like if we ever did.

1. **A sibling contract `BehaviourConsensus`** sharing the existing peer registry, with the four field deltas in §5. Deploy on BSC alongside `EvidenceConsensus`.
2. **A new front-end surface `/behaviour`** mirroring `/evidence` but oriented to the behaviour record schema. The peer dashboard merges the two queues.
3. **An attestation pipeline** for filing behaviour records: a small CLI / SDK that hashes a (model, input, output) bundle, uploads the canonical text to the cache, and emits the on-chain submission. Designed so labs, red-teamers, and individual users can all file with the same tool.
4. **Three reference Tier-I evals canonised by the existing Genesis peer**, in three of the nine domains (suggestion: honesty, harm-avoidance, power-seeking), to seed the canon. Each is one behaviour, fully specified, with model hash + transcript hash + reproducer code.
5. **The seed phase opens to public nomination** when the peer count crosses a configured K — same flow as the evidence system. Recommended K is meaningfully larger here than for evidence, because the consequences of capture are higher. Twenty independent peers is a reasonable starting point.
6. **AI peer admission** is gated behind step 5 and behind a separate canon item that defines the admission criteria. No AI peer until humans have set the rules, in public, with names on them.

Steps 1–5 are bounded engineering work using primitives that already exist in your codebase. Step 6 is where the proposal becomes a piece of real infrastructure for the post-AGI world.

---

## 10. Closing

The whitepaper ends with a line I want to borrow:

> *"None of this guarantees that the system will arrive at the truth. What it guarantees is that the search for the truth will happen in the open, that the work of judgement will be visible, and that future readers will be able to trace exactly how we came to believe what we did — and, when they decide we were wrong, change it."*

If we read *"truth"* as *"alignment"*, that paragraph is the safety case for superintelligence. It is the only safety case I find honest, because it does not require any single party — lab, government, model, or me — to be right. It only requires the network to keep working: open identity, open count, open revisability, public hash, public history.

That is not a small ask. It is also not a new ask. It is the same ask the whitepaper has already answered, for a smaller domain, with a working system.

The question is whether we extend the system before we need it, or after.

I think before.
