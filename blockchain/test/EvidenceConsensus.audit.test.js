const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const NodeState = { None: 0, Proposed: 1, Ratified: 2, Retired: 3 };
const State = { None: 0, Submitted: 1, Canon: 2, Expelled: 3, Lapsed: 4, Contested: 5, Deprecated: 6, Reaffirmed: 7 };

const DAY = 24 * 60 * 60;
const PENDING_WINDOW   = 30 * DAY;
const CHALLENGE_WINDOW = 21 * DAY;
const PROPOSAL_WINDOW  = 30 * DAY;
const OPEN_SEED = 1_000_000; // keeps owner addPeer available so a test can grow the active set

function evidenceId(seed) { return ethers.zeroPadValue(ethers.toBeHex(BigInt(seed)), 32); }
function ch(body)         { return ethers.keccak256(ethers.toUtf8Bytes(body)); }
function nodeId(slug)     { return ethers.keccak256(ethers.toUtf8Bytes(slug)); }

// Deploy with `n` real (signable) genesis peers and a single ratified topic so
// the review/challenge paths have somewhere to file evidence.  Returns the topic
// id plus the signer set.  seedPhaseK lets a test grow the set via owner addPeer.
async function deployWithTopic(n, seedPhaseK = 0) {
  const signers = await ethers.getSigners();
  const peers   = signers.slice(0, n);
  const Factory = await ethers.getContractFactory("EvidenceConsensus");
  const c = await Factory.deploy(peers.map(s => s.address), peers.map((_, i) => `G-${i}`), seedPhaseK);
  await c.waitForDeployment();

  const PILLAR = nodeId("seed-pillar");
  const TOPIC  = nodeId("seed-topic");
  await c.connect(peers[0]).proposePillar(PILLAR, ch("mp"), TOPIC, ch("mt"), evidenceId(90001), 2, ch("fe"));
  let i = 1;
  while (Number((await c.getTaxonomyNode(PILLAR)).state) !== NodeState.Ratified) {
    await c.connect(peers[i]).endorseNode(PILLAR);
    i++;
  }
  return { c, signers, peers, TOPIC };
}

describe("AUDIT FIX — proposePillar rejects a reserved topic id as its own id", () => {
  it("reverts when a pillar tries to register at another pending pillar's reserved child topic id", async () => {
    const signers = await ethers.getSigners();
    const peers   = signers.slice(0, 4); // n=4 → bundleThreshold(tier2)=3, so A stays pending
    const Factory = await ethers.getContractFactory("EvidenceConsensus");
    const contract = await Factory.deploy(peers.map(s => s.address), peers.map((_, i) => `G-${i}`), 0);
    await contract.waitForDeployment();

    const A_ID = nodeId("pillar-A");
    const FT   = nodeId("pillar-A-founding-topic");
    await contract.connect(peers[0]).proposePillar(A_ID, ch("mA"), FT, ch("mFT"), evidenceId(1), 2, ch("cA"));
    expect(await contract.topicReserved(FT)).to.equal(true);

    // The loophole is now closed: a pillar cannot occupy the reserved topic id.
    await expect(
      contract.connect(peers[0]).proposePillar(FT, ch("mB"), nodeId("b-child"), ch("mBc"), evidenceId(2), 2, ch("cB")),
    ).to.be.revertedWith("node exists");

    // The legitimate pillar still ratifies and materializes its child cleanly.
    await contract.connect(peers[1]).endorseNode(A_ID);
    await contract.connect(peers[2]).endorseNode(A_ID); // → 3 → ratifies (majority gate)
    const ft = await contract.getTaxonomyNode(FT);
    expect(ft.state).to.equal(NodeState.Ratified);
  });
});

describe("AUDIT FIX — nominations stay open after the owner renounces", () => {
  it("allows community nomination even if the active set drops below seedPhaseK post-renounce", async () => {
    const signers = await ethers.getSigners();
    const genesis = signers.slice(0, 3); // n = 3 == seedPhaseK
    const Factory = await ethers.getContractFactory("EvidenceConsensus");
    const contract = await Factory.deploy(genesis.map(s => s.address), genesis.map((_, i) => `G-${i}`), 3);
    await contract.waitForDeployment();

    await contract.renounceOwnership();
    expect(await contract.owner()).to.equal(ethers.ZeroAddress);

    await contract.connect(genesis[0]).motionRevoke(genesis[2].address);
    await contract.connect(genesis[1]).voteRevoke(genesis[2].address); // n → 2 (< seedPhaseK)
    expect(await contract.activePeerCount()).to.equal(2n);

    // Previously this reverted ("seed phase: owner must seed peers first") with no
    // owner left to seed — a permanent liveness trap. Now the network can grow.
    expect(await contract.nominationsOpen()).to.equal(true);
    await expect(contract.connect(genesis[0]).nominatePeer(signers[4].address, "T"))
      .to.emit(contract, "PeerNominated");
  });
});

// ── A. Force-renounce: peer supermajority evicts a captured owner ─────────────
describe("HARDENING A — peers can evict a captured/paused owner", () => {
  it("a 2/3 supermajority strips a paused owner and unpauses the contract", async () => {
    const { c, peers } = await deployWithTopic(3); // retireThreshold(3) = ceil(2*3/3) = 2
    await c.connect(peers[0]).pause();             // owner (peers[0]) bricks the network
    expect(await c.paused()).to.equal(true);

    await c.connect(peers[1]).motionForceRenounce();          // vote #1 (works while paused)
    await expect(c.connect(peers[2]).voteForceRenounce())     // vote #2 → reaches 2/3
      .to.emit(c, "OwnershipTransferred").withArgs(peers[0].address, ethers.ZeroAddress)
      .and.to.emit(c, "Unpaused");

    expect(await c.owner()).to.equal(ethers.ZeroAddress);
    expect(await c.paused()).to.equal(false);
    expect(await c.forceRenounceActive()).to.equal(false);
  });

  it("a sub-threshold motion can be restarted after the window (no permanent block)", async () => {
    const { c, peers } = await deployWithTopic(4); // retireThreshold(4) = ceil(8/3) = 3
    await c.connect(peers[1]).motionForceRenounce(); // 1 vote, 1 < 3 → stays open
    expect(await c.forceRenounceActive()).to.equal(true);
    expect(await c.forceRenounceVotes()).to.equal(1n);

    // Re-motioning before the window is rejected; after it, a fresh round starts.
    await expect(c.connect(peers[2]).motionForceRenounce()).to.be.revertedWith("force-renounce active");
    await time.increase(PROPOSAL_WINDOW + 1);
    await c.connect(peers[2]).motionForceRenounce(); // stale → restart, fresh round
    expect(await c.forceRenounceVotes()).to.equal(1n);
  });

  it("rejects a force-renounce motion when there is no owner", async () => {
    const { c, peers } = await deployWithTopic(3);
    await c.connect(peers[0]).renounceOwnership();
    expect(await c.owner()).to.equal(ethers.ZeroAddress);
    await expect(c.connect(peers[1]).motionForceRenounce()).to.be.revertedWith("no owner");
  });
});

// ── D. On-chain cap on outstanding taxonomy proposals ─────────────────────────
describe("HARDENING D — taxonomy-proposal spam cap", () => {
  it("caps a peer's outstanding proposals and frees a slot on lapse", async () => {
    const { c, peers } = await deployWithTopic(4); // bundleThreshold(2)@4 = 3 → lone proposals stay pending
    const MAX = 8;
    for (let k = 0; k < MAX; k++) {
      await c.connect(peers[0]).proposePillar(
        nodeId("spam-" + k), ch("m" + k), nodeId("spam-ft-" + k), ch("ft" + k),
        evidenceId(1000 + k), 2, ch("c" + k),
      );
    }
    expect(await c.pendingProposals(peers[0].address)).to.equal(BigInt(MAX));
    // 9th proposal is blocked.
    await expect(c.connect(peers[0]).proposePillar(
      nodeId("spam-9"), ch("m9"), nodeId("spam-ft-9"), ch("ft9"), evidenceId(1099), 2, ch("c9"),
    )).to.be.revertedWith("proposal cap reached");

    // Lapsing one frees a slot, and a new proposal then succeeds.
    await time.increase(PROPOSAL_WINDOW + 1);
    await c.lapseProposal(nodeId("spam-0"));
    expect(await c.pendingProposals(peers[0].address)).to.equal(BigInt(MAX - 1));
    await expect(c.connect(peers[0]).proposePillar(
      nodeId("spam-9"), ch("m9"), nodeId("spam-ft-9"), ch("ft9"), evidenceId(1099), 2, ch("c9"),
    )).to.emit(c, "PillarProposed");
  });

  it("frees a proposal slot when the node ratifies", async () => {
    const { c, peers } = await deployWithTopic(4); // gate = 3
    await c.connect(peers[0]).proposePillar(
      nodeId("rat"), ch("m"), nodeId("rat-ft"), ch("ft"), evidenceId(1200), 2, ch("c"),
    );
    expect(await c.pendingProposals(peers[0].address)).to.equal(1n);
    await c.connect(peers[1]).endorseNode(nodeId("rat"));
    await c.connect(peers[2]).endorseNode(nodeId("rat")); // → 3 → ratifies
    expect((await c.getTaxonomyNode(nodeId("rat"))).state).to.equal(NodeState.Ratified);
    expect(await c.pendingProposals(peers[0].address)).to.equal(0n);
  });
});

// ── E. Per-binding peer-count snapshot (order-independence) ───────────────────
describe("HARDENING E — review outcome is judged against a peer-count snapshot", () => {
  it("a binding canonizes against the snapshot, not the live (grown) peer set", async () => {
    // n=4 → canonize(tier3) = ceil(4*0.51) = 3.  Grow to n=10 (where canonize would
    // be 6) mid-review; 3 approves must still canonize because the snapshot is 4.
    const { c, peers } = await deployWithTopic(4, OPEN_SEED);
    const id = evidenceId(1);
    await c.connect(peers[0]).submitEvidence(id, 3, nodeId("seed-topic"), ch("x"));
    expect((await c.getBinding(id, nodeId("seed-topic"))).peerSnapshot).to.equal(4n);

    for (let k = 0; k < 6; k++) await c.addPeer(ethers.Wallet.createRandom().address, "p");
    expect(await c.activePeerCount()).to.equal(10n);
    expect(await c.canonizeThreshold(3)).to.equal(6n); // live threshold is now 6

    for (let i = 0; i < 3; i++) await c.connect(peers[i]).castReviewVote(id, nodeId("seed-topic"), true);
    expect((await c.getBinding(id, nodeId("seed-topic"))).state).to.equal(State.Canon); // snapshot bar = 3
  });

  it("review outcome is independent of vote order for a fixed vote multiset", async () => {
    // n=5 tier1: canonize = ceil(5*0.60) = 3; early-expel needs reject > 5-3 = 2 (≥3).
    // The multiset {3 approve, 2 reject} canonizes regardless of order.
    async function run(order) {
      const { c, peers } = await deployWithTopic(5);
      const id = evidenceId(7);
      await c.connect(peers[0]).submitEvidence(id, 1, nodeId("seed-topic"), ch("x"));
      for (let i = 0; i < order.length; i++) {
        await c.connect(peers[i]).castReviewVote(id, nodeId("seed-topic"), order[i]);
      }
      return Number((await c.getBinding(id, nodeId("seed-topic"))).state);
    }
    const a = await run([true, false, true, false, true]);
    const b = await run([false, false, true, true, true]);
    expect(a).to.equal(State.Canon);
    expect(b).to.equal(State.Canon);
  });

  it("activeReviewCount survives open→lapse→re-file→canon without underflow", async () => {
    const { c, peers } = await deployWithTopic(3); // canonize(2)@3 = 2
    const id = evidenceId(2);
    const TOPIC = nodeId("seed-topic");
    await c.connect(peers[0]).submitEvidence(id, 2, TOPIC, ch("x"));
    expect(await c.activeReviewCount()).to.equal(1n);

    await time.increase(PENDING_WINDOW + 1);
    await c.markLapsed(id, TOPIC);
    expect(await c.activeReviewCount()).to.equal(0n); // slot freed on lapse

    await c.connect(peers[1]).fileBinding(id, TOPIC); // re-file occupies a slot again
    expect(await c.activeReviewCount()).to.equal(1n);
    await c.connect(peers[0]).castReviewVote(id, TOPIC, true);
    await c.connect(peers[1]).castReviewVote(id, TOPIC, true); // → canon, frees the slot
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Canon);
    expect(await c.activeReviewCount()).to.equal(0n);
  });
});

// ── Challenge defense math (audit gap) ────────────────────────────────────────
describe("HARDENING — challenge deprecate vs reaffirm math", () => {
  async function canonize(c, peers, id, tier, TOPIC) {
    await c.connect(peers[0]).submitEvidence(id, tier, TOPIC, ch("e" + id));
    const need = Number(await c.canonizeThreshold(tier));
    for (let i = 0; i < need; i++) await c.connect(peers[i]).castReviewVote(id, TOPIC, true);
  }

  it("deprecates only when challenge votes reach deprecateThreshold", async () => {
    const { c, peers } = await deployWithTopic(5); // deprecateThreshold(2)@5 = ceil(5*0.60) = 3
    const id = evidenceId(3), TOPIC = nodeId("seed-topic");
    await canonize(c, peers, id, 2, TOPIC);
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Canon);

    await c.connect(peers[0]).openChallenge(id, TOPIC);            // challengeVotes = 1
    await c.connect(peers[1]).castChallengeVote(id, TOPIC, true);  // = 2 (< 3)
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Contested);
    await c.connect(peers[2]).castChallengeVote(id, TOPIC, true);  // = 3 → deprecate
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Deprecated);
  });

  it("reaffirms a defended binding at window close (defense holds the line)", async () => {
    const { c, peers } = await deployWithTopic(5); // deprecateThreshold(2)@5 = 3
    const id = evidenceId(4), TOPIC = nodeId("seed-topic");
    await canonize(c, peers, id, 2, TOPIC);

    await c.connect(peers[0]).openChallenge(id, TOPIC);            // challengeVotes = 1
    await c.connect(peers[1]).castChallengeVote(id, TOPIC, false); // defense
    await c.connect(peers[2]).castChallengeVote(id, TOPIC, false); // defense; challenge stays at 1 < 3
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(c.finalizeChallenge(id, TOPIC)).to.emit(c, "BindingReaffirmed");
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Reaffirmed);
  });
});

// ── F1. Review order-independence holds even when the active set GROWS ─────────
// The early-expel "canon impossible" test is judged against the LIVE electorate,
// so growing the set mid-window can no longer flip the verdict on vote order.
describe("AUDIT FIX F1 — review verdict is order-independent under peer-set growth", () => {
  async function run(rejectFirst) {
    const { c, signers, peers } = await deployWithTopic(4, OPEN_SEED);
    const TOPIC = nodeId("seed-topic");
    const id = evidenceId(4101);
    // tier 3 → canonize(snapshot 4) = 3; early-expel now needs reject > live - canonize
    await c.connect(peers[0]).submitEvidence(id, 3, TOPIC, ch("x"));
    await c.connect(peers[0]).addPeer(signers[4].address, "p4");
    await c.connect(peers[0]).addPeer(signers[5].address, "p5"); // live = 6
    const approvers = [peers[1], peers[2], peers[3]]; // 3 approves
    const rejecters = [signers[4], signers[5]];       // 2 rejects
    const cast = (s, v) => c.connect(s).castReviewVote(id, TOPIC, v);
    if (rejectFirst) {
      for (const s of rejecters) await cast(s, false);
      for (const s of approvers) { try { await cast(s, true); } catch (_) {} }
    } else {
      for (const s of approvers) await cast(s, true);
      for (const s of rejecters) { try { await cast(s, false); } catch (_) {} }
    }
    return Number((await c.getBinding(id, TOPIC)).state);
  }

  it("the same {3 approve, 2 reject} multiset canonizes regardless of vote order", async () => {
    expect(await run(false)).to.equal(State.Canon); // approves first
    expect(await run(true)).to.equal(State.Canon);  // rejects first — same outcome now
  });
});

// ── F1b. Deprecation is judged against the LIVE peer set ──────────────────────
describe("AUDIT FIX F1b — canon evidence needs a live supermajority to deprecate", () => {
  it("a stale (small) snapshot no longer lets a minority deprecate after growth", async () => {
    const { c, signers, peers } = await deployWithTopic(4, OPEN_SEED);
    const TOPIC = nodeId("seed-topic");
    const id = evidenceId(4201);
    await c.connect(peers[0]).submitEvidence(id, 1, TOPIC, ch("y")); // canonize(1)@4 = 3
    for (let i = 0; i < 3; i++) await c.connect(peers[i]).castReviewVote(id, TOPIC, true);
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Canon);

    await c.connect(peers[0]).openChallenge(id, TOPIC); // challengeVotes = 1 (snapshot 4)
    for (let k = 4; k < 10; k++) await c.connect(peers[0]).addPeer(signers[k].address, "p" + k);
    expect(await c.deprecateThreshold(1)).to.equal(7n); // live supermajority

    // challenger + 2 = 3 votes: would have deprecated on the stale snapshot, now must NOT
    await c.connect(peers[1]).castChallengeVote(id, TOPIC, true);
    await c.connect(peers[2]).castChallengeVote(id, TOPIC, true);
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Contested);

    // a genuine live supermajority (7) does deprecate
    for (let k = 3; k < 7; k++) await c.connect(signers[k]).castChallengeVote(id, TOPIC, true);
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Deprecated);
  });
});

// ── F3. A peer-set shrink lapses (not expels) an unrejected binding ───────────
// Early-expel is judged against the LIVE count for growth, but a heavy shrink can
// drop the active set below the snapshot canonize target.  A stray reject then
// makes canon arithmetically impossible — but that is membership churn, not a
// verdict, so the binding must LAPSE (re-filable), never terminally Expel.
describe("AUDIT FIX F3 — a peer-set shrink lapses an unrejected binding, never expels it", () => {
  it("under heavy revocation, a stray reject cannot terminally expel a re-filable binding", async () => {
    const { c, peers } = await deployWithTopic(10);
    const TOPIC = nodeId("seed-topic");
    const id = evidenceId(4401);

    // tier-1 @ snapshot 10 → canonize 6, expelThreshold(10) = 3.
    await c.connect(peers[0]).submitEvidence(id, 1, TOPIC, ch("x"));
    expect((await c.getBinding(id, TOPIC)).peerSnapshot).to.equal(10n);

    // Revoke peers[5..9], shrinking the active set 10 → 5 (voters: peers[0..4]).
    for (let t = 9; t >= 5; t--) {
      const n = Number(await c.activePeerCount());
      const need = Math.floor(n / 2) + (n % 2); // ceil(n/2) = revokeThreshold
      await c.connect(peers[0]).motionRevoke(peers[t].address); // vote #1
      for (let v = 1; v < need; v++) await c.connect(peers[v]).voteRevoke(peers[t].address);
    }
    expect(await c.activePeerCount()).to.equal(5n);

    // A single reject makes canon arithmetically impossible (6 > 5), but with only
    // 1 < expelThreshold(snapshot 10)=3 rejections this is churn, not a verdict, so
    // it LAPSES (re-filable) instead of terminally Expelling.
    await expect(c.connect(peers[1]).castReviewVote(id, TOPIC, false))
      .to.emit(c, "BindingLapsed");
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Lapsed);

    // Re-filed at the new (smaller) snapshot — canonize(1)@5 = 3 — it canonizes cleanly.
    await c.connect(peers[0]).fileBinding(id, TOPIC);
    expect((await c.getBinding(id, TOPIC)).peerSnapshot).to.equal(5n);
    for (let i = 0; i < 3; i++) await c.connect(peers[i]).castReviewVote(id, TOPIC, true);
    expect((await c.getBinding(id, TOPIC)).state).to.equal(State.Canon);
  });
});

// ── F2. A topic cannot ratify under a pillar retired while it was in flight ────
describe("AUDIT FIX F2 — no ratified topic orphaned under a retired pillar", () => {
  it("an in-flight topic proposal does not ratify once its parent pillar is retired", async () => {
    const { c, peers, TOPIC } = await deployWithTopic(5); // retireThreshold(5) = 4
    const PILLAR = nodeId("seed-pillar");
    const T1 = nodeId("late-topic-fix");
    await c.connect(peers[0]).proposeTopic(T1, PILLAR, ch("mt1"), evidenceId(4301), 2, ch("fe1"));

    // Retiring the founding topic (the pillar's only ratified topic) auto-retires
    // the pillar in the same tx — pillars are never retired directly.
    await c.connect(peers[0]).motionRetireNode(TOPIC);
    await c.connect(peers[1]).voteRetireNode(TOPIC);
    await c.connect(peers[2]).voteRetireNode(TOPIC);
    await c.connect(peers[3]).voteRetireNode(TOPIC); // 4 = retireThreshold(5)
    expect((await c.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Retired);

    // endorsing T1 past its gate must NOT ratify it now (parent is retired)
    await c.connect(peers[1]).endorseNode(T1);
    await c.connect(peers[2]).endorseNode(T1);
    expect((await c.getTaxonomyNode(T1)).state).to.equal(NodeState.Proposed);
    expect(await c.topicIds(PILLAR)).to.not.include(T1);
    expect((await c.getBinding(evidenceId(4301), T1)).state).to.equal(State.None);

    // it garbage-collects normally after the window
    await time.increase(PROPOSAL_WINDOW + 1);
    await c.lapseProposal(T1);
    expect((await c.getTaxonomyNode(T1)).state).to.equal(NodeState.None);
  });
});
