const { expect }  = require("chai");
const { ethers }  = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ZERO_HASH = "0x" + "0".repeat(64);

// Binding lifecycle (None is the zero default for an absent binding).
const State = {
  None:       0,
  Submitted:  1,
  Canon:      2,
  Expelled:   3,
  Lapsed:     4,
  Contested:  5,
  Deprecated: 6,
  Reaffirmed: 7,
  Queued:     8,
};

// JS mirrors of the contract's internal threshold formulas (`_canonizeThresholdAt`
// etc.).  The standalone percentage getters were removed from the core for EIP-170
// headroom — the frontend computes them off-chain (src/evidence-data.js) and the
// behavioural tests exercise the on-chain `_*At` helpers indirectly; these mirrors
// drive vote loops and pin the expected numbers.
const ceilPct  = (n, pct) => Math.max(1, Math.ceil((n * pct) / 100));
const canonT   = (tier, n) => ceilPct(n, tier === 1 ? 60 : tier === 2 ? 55 : 51);
const expelT   = (n) => ceilPct(n, 25);
const deprecT  = (tier, n) => ceilPct(n, tier === 1 ? 65 : tier === 2 ? 60 : 55);
const taxT     = (n) => Math.floor(n / 2) + 1;
const bundleT  = (tier, n) => Math.max(taxT(n), canonT(tier, n));

const DAY  = 24 * 60 * 60;
const PENDING_WINDOW      = 30 * DAY;
const CHALLENGE_WINDOW    = 21 * DAY;
const CHALLENGE_COOLDOWN  = 7 * DAY;
const RECHALLENGE_COOLDOWN = 30 * DAY;
const PROPOSAL_WINDOW     = 30 * DAY;
const REVOKE_WINDOW       = 14 * DAY;

// A practically-infinite seed phase, so owner `addPeer` stays available
// throughout a test that needs to grow the active set (addPeer is seed-phase
// only in the trustless model).
const OPEN_SEED = 1_000_000;

// keccak-style id helpers
function evidenceId(seed) {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(seed)), 32);
}
function contentHash(body) {
  return ethers.keccak256(ethers.toUtf8Bytes(body));
}
// Taxonomy node id = keccak256(utf8(slug)), matching the off-chain/wallet helper.
function nodeId(slug) {
  return ethers.keccak256(ethers.toUtf8Bytes(slug));
}
// Off-chain mirror of the contract's bindingId(id, topicId).
function bindingId(id, topicId) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [id, topicId]),
  );
}

const NodeKind  = { Pillar: 0, Topic: 1 };
const NodeState = { None: 0, Proposed: 1, Ratified: 2, Retired: 3, Rejected: 4 };

// Sign a Vote(bindingId, phase, support, noteHash) EIP-712 typed message with the
// voting signer; the contract recovers this signer on-chain and attributes the
// vote to it (the submitter may be any relayer).  phase: 0 = review, 1 = challenge.
async function signVote(signer, consensusAddr, chainId, bindingId, phase, support, round, noteHash) {
  const domain = { name: "EvidenceConsensus", version: "1", chainId, verifyingContract: consensusAddr };
  const types = {
    Vote: [
      { name: "bindingId", type: "bytes32" },
      { name: "phase",     type: "uint8" },
      { name: "support",   type: "bool" },
      { name: "round",     type: "uint32" },
      { name: "noteHash",  type: "bytes32" },
    ],
  };
  return signer.signTypedData(domain, types, { bindingId, phase, support, round, noteHash });
}

// Convenience wrappers that sign with `signer` and submit (relayed by `signer`
// too, but attribution is the recovered signer).  These mirror the old call
// shapes so the test bodies stay focused on intent rather than signing plumbing.
async function reviewVote(contract, signer, id, topicId, approve, noteHash = ZERO_HASH) {
  const bid     = await contract.bindingId(id, topicId);
  const round   = (await contract.getBinding(id, topicId)).reviewRound;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const sig     = await signVote(signer, await contract.getAddress(), chainId, bid, 0, approve, round, noteHash);
  return contract.connect(signer).castReviewVote(id, topicId, approve, noteHash, sig);
}

async function openChallengeSigned(contract, signer, id, topicId, noteHash = ZERO_HASH) {
  const bid     = await contract.bindingId(id, topicId);
  const round   = (await contract.getBinding(id, topicId)).challengeRound + 1n; // open creates round+1
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const sig     = await signVote(signer, await contract.getAddress(), chainId, bid, 1, true, round, noteHash);
  return contract.connect(signer).openChallenge(id, topicId, noteHash, sig);
}

async function challengeVote(contract, signer, id, topicId, support, noteHash = ZERO_HASH) {
  const bid     = await contract.bindingId(id, topicId);
  const round   = (await contract.getBinding(id, topicId)).challengeRound;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const sig     = await signVote(signer, await contract.getAddress(), chainId, bid, 1, support, round, noteHash);
  return contract.connect(signer).castChallengeVote(id, topicId, support, noteHash, sig);
}

// ── PeerGovernance vote-by-signature helpers ─────────────────────────────────
// Membership votes (endorse a nominee / discard a peer) are authorised by an
// EIP-712 PeerVote signed by the voter and bound to the subject's current round
// + an optional noteHash. These wrappers sign with `signer` and submit, mirroring
// the reviewVote/challengeVote shapes so test bodies read as intent.
const VK_NOMINEE = 0;
const VK_REVOKE  = 1;
async function signPeerVote(signer, govAddr, chainId, subject, kind, support, round, noteHash) {
  const domain = { name: "PeerGovernance", version: "1", chainId, verifyingContract: govAddr };
  const types = {
    PeerVote: [
      { name: "subject",  type: "address" },
      { name: "kind",     type: "uint8"   },
      { name: "support",  type: "bool"    },
      { name: "round",    type: "uint32"  },
      { name: "noteHash", type: "bytes32" },
    ],
  };
  return signer.signTypedData(domain, types, { subject, kind, support, round, noteHash });
}
async function endorseNomineeSigned(gov, signer, nominee, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = await gov.nomineeRound(nominee);
  const sig     = await signPeerVote(signer, await gov.getAddress(), chainId, nominee, VK_NOMINEE, true, round, noteHash);
  return gov.connect(signer).endorseNominee(nominee, noteHash, sig);
}
async function motionRevokeSigned(gov, signer, peer, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = (await gov.revokeRound(peer)) + 1n; // a motion opens current + 1
  const sig     = await signPeerVote(signer, await gov.getAddress(), chainId, peer, VK_REVOKE, true, round, noteHash);
  return gov.connect(signer).motionRevoke(peer, noteHash, sig);
}
async function voteRevokeSigned(gov, signer, peer, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = await gov.revokeRound(peer);
  const sig     = await signPeerVote(signer, await gov.getAddress(), chainId, peer, VK_REVOKE, true, round, noteHash);
  return gov.connect(signer).voteRevoke(peer, noteHash, sig);
}

// ── Taxonomy / retire / force-renounce vote-by-signature helpers ─────────────
// These reuse the core `Vote` typehash with the governance phases (2 = taxonomy
// propose/endorse, 3 = retire, 4 = force-renounce). A propose/motion mints the
// node/owner round (current + 1); an endorse/vote signs the current round.
const VP_TAXONOMY = 2;
const VP_RETIRE   = 3;
const VP_FORCE    = 4;
const FORCE_RENOUNCE_ID = nodeId("force-renounce");

async function proposePillarSigned(contract, signer, id, metaHash, topicId, topicMetaHash, evidenceId, tier, ch, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = (await contract.nodeRound(id)) + 1n;
  const sig     = await signVote(signer, await contract.getAddress(), chainId, id, VP_TAXONOMY, true, round, noteHash);
  return contract.connect(signer).proposePillar(id, metaHash, topicId, topicMetaHash, evidenceId, tier, ch, noteHash, sig);
}
async function proposeTopicSigned(contract, signer, id, parentPillar, metaHash, evidenceId, tier, ch, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = (await contract.nodeRound(id)) + 1n;
  const sig     = await signVote(signer, await contract.getAddress(), chainId, id, VP_TAXONOMY, true, round, noteHash);
  return contract.connect(signer).proposeTopic(id, parentPillar, metaHash, evidenceId, tier, ch, noteHash, sig);
}
async function endorseNodeSigned(contract, signer, id, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = await contract.nodeRound(id);
  const sig     = await signVote(signer, await contract.getAddress(), chainId, id, VP_TAXONOMY, true, round, noteHash);
  return contract.connect(signer).endorseNode(id, noteHash, sig);
}
// A taxonomy reject reuses the taxonomy phase with support=false over the node's
// current round.
async function rejectNodeSigned(contract, signer, id, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = await contract.nodeRound(id);
  const sig     = await signVote(signer, await contract.getAddress(), chainId, id, VP_TAXONOMY, false, round, noteHash);
  return contract.connect(signer).rejectNode(id, noteHash, sig);
}
async function motionRetireSigned(contract, signer, id, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = (await contract.retireRound(id)) + 1n;
  const sig     = await signVote(signer, await contract.getAddress(), chainId, id, VP_RETIRE, true, round, noteHash);
  return contract.connect(signer).motionRetireNode(id, noteHash, sig);
}
async function voteRetireSigned(contract, signer, id, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = await contract.retireRound(id);
  const sig     = await signVote(signer, await contract.getAddress(), chainId, id, VP_RETIRE, true, round, noteHash);
  return contract.connect(signer).voteRetireNode(id, noteHash, sig);
}
async function motionForceRenounceSigned(contract, signer, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = (await contract.forceRenounceRound()) + 1n;
  const sig     = await signVote(signer, await contract.getAddress(), chainId, FORCE_RENOUNCE_ID, VP_FORCE, true, round, noteHash);
  return contract.connect(signer).motionForceRenounce(noteHash, sig);
}
async function voteForceRenounceSigned(contract, signer, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = await contract.forceRenounceRound();
  const sig     = await signVote(signer, await contract.getAddress(), chainId, FORCE_RENOUNCE_ID, VP_FORCE, true, round, noteHash);
  return contract.connect(signer).voteForceRenounce(noteHash, sig);
}
// Nominate is the nominator's own PeerVote (kind 2), bound to the round it mints.
const VK_NOMINATE = 2;
async function nominateSigned(gov, signer, nominee, handle, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = (await gov.nomineeRound(nominee)) + 1n;
  const sig     = await signPeerVote(signer, await gov.getAddress(), chainId, nominee, VK_NOMINATE, true, round, noteHash);
  return gov.connect(signer).nominatePeer(nominee, handle, noteHash, sig);
}

// Sign a batch of review votes with a single `signer` (one per element) and
// submit them via castReviewVoteBatch.  noteHashes default to ZERO_HASH.
// Pass `overrides` to deliberately mismatch array lengths in negative tests.
async function reviewVoteBatch(contract, signer, ids, topicIds, approves, overrides = {}) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const addr    = await contract.getAddress();
  const noteHashes = overrides.noteHashes ?? ids.map(() => ZERO_HASH);
  let sigs = overrides.sigs;
  if (!sigs) {
    sigs = [];
    for (let i = 0; i < ids.length; i++) {
      const bid   = await contract.bindingId(ids[i], topicIds[i]);
      const round = (await contract.getBinding(ids[i], topicIds[i])).reviewRound;
      sigs.push(await signVote(signer, addr, chainId, bid, 0, approves[i], round, noteHashes[i]));
    }
  }
  return contract.connect(signer).castReviewVoteBatch(ids, topicIds, approves, noteHashes, sigs);
}

// A deterministic baseline pillar + two topics seeded into every deploy() so the
// submitEvidence path has ratified topics to file bindings under. Every taxonomy
// node is bootstrapped with a founding piece of evidence (bundled into the
// proposal), so the seed also creates one canon binding per topic. The founding
// evidence ids are kept far out of the range tests use for their own evidence.
const DEFAULT_PILLAR  = nodeId("pillar-default");
const DEFAULT_TOPIC   = nodeId("topic-default");     // founding child topic of the pillar
const DEFAULT_TOPIC_2 = nodeId("topic-default-2");
const FOUNDING_EV_1   = evidenceId(90001);           // founding evidence of DEFAULT_TOPIC
const FOUNDING_EV_2   = evidenceId(90002);           // founding evidence of DEFAULT_TOPIC_2

// Drive a node from proposal to ratification.  The proposer's call counts as
// endorsement #1; we add more endorsements from distinct peers until the node
// flips to Ratified (the gate is bundleThreshold(tier), which can exceed the
// bare taxonomy threshold for tier-1/2 founding evidence).
async function ratify(contract, peers, proposeCall, id) {
  await proposeCall();
  let i = 1;
  while (Number((await contract.getTaxonomyNode(id)).state) !== NodeState.Ratified) {
    await endorseNodeSigned(contract, peers[i], id);
    i++;
  }
}

async function seedDefaultTaxonomy(contract, peers) {
  // The pillar bundles its first topic (DEFAULT_TOPIC) + founding evidence.
  await ratify(
    contract, peers,
    () => proposePillarSigned(
      contract, peers[0],
      DEFAULT_PILLAR, contentHash("pillar-meta"),
      DEFAULT_TOPIC,  contentHash("topic-meta"),
      FOUNDING_EV_1,  2, contentHash("founding-ev-1"),
    ),
    DEFAULT_PILLAR,
  );
  // A second topic under the same pillar bundles its own founding evidence.
  await ratify(
    contract, peers,
    () => proposeTopicSigned(
      contract, peers[0],
      DEFAULT_TOPIC_2, DEFAULT_PILLAR, contentHash("topic-meta-2"),
      FOUNDING_EV_2,   2, contentHash("founding-ev-2"),
    ),
    DEFAULT_TOPIC_2,
  );
}

async function deploy(seedPhaseK = 0, genesisSize = 1, seedTax = true) {
  const signers = await ethers.getSigners();
  const genesis = signers.slice(0, genesisSize);
  const handles = genesis.map((_, i) => `Genesis-${i}`);
  const Factory = await ethers.getContractFactory("EvidenceConsensus");
  const contract = await Factory.deploy(
    genesis.map(s => s.address),
    handles,
    seedPhaseK,
  );
  await contract.waitForDeployment();
  // Peer-governance sidecar holding the nominee + revocation flows moved off the
  // core for EIP-170 headroom; wired once via setGovernance so it can admit/revoke.
  const Gov = await ethers.getContractFactory("PeerGovernance");
  const gov = await Gov.deploy(await contract.getAddress());
  await gov.waitForDeployment();
  await contract.setGovernance(await gov.getAddress());
  // Read-only sidecar holding the peer/nominee/proposal aggregation views moved
  // off the core for EIP-170 headroom (reads nominee/revoke state from gov).
  const Lens = await ethers.getContractFactory("EvidenceConsensusLens");
  const lens = await Lens.deploy(await contract.getAddress(), await gov.getAddress());
  await lens.waitForDeployment();
  if (seedTax) await seedDefaultTaxonomy(contract, genesis);
  return { contract, gov, lens, signers, genesis };
}

// Read a binding's state for the default topic (most tests use one topic).
async function bindingState(contract, id, topicId = DEFAULT_TOPIC) {
  return Number((await contract.getBinding(id, topicId)).state);
}

// Owner-seed random peers up to `target` active peers.  Requires the contract
// to still be in its seed phase (deploy with OPEN_SEED).  Random addresses can
// be counted but cannot sign, so use this only to exercise threshold *curves*.
async function padPeers(contract, target) {
  for (let n = Number(await contract.activePeerCount()); n < target; n++) {
    await contract.addPeer(ethers.Wallet.createRandom().address, "p");
  }
}

describe("EvidenceConsensus — deployment", () => {
  it("rejects empty genesis set", async () => {
    const Factory = await ethers.getContractFactory("EvidenceConsensus");
    await expect(Factory.deploy([], [], 0)).to.be.revertedWith("need at least one genesis peer");
  });

  it("rejects mismatched address/handle lengths", async () => {
    const [a, b] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EvidenceConsensus");
    await expect(Factory.deploy([a.address, b.address], ["only-one"], 0))
      .to.be.revertedWith("length mismatch");
  });

  it("seeds genesis peer, owner, and seedPhaseK", async () => {
    const { contract, lens, signers } = await deploy(5, 1, false);
    expect(await contract.owner()).to.equal(signers[0].address);
    expect(await contract.genesis()).to.equal(signers[0].address);
    expect(await contract.seedPhaseK()).to.equal(5n);
    expect(await contract.activePeerCount()).to.equal(1n);
    expect(await contract.isActivePeer(signers[0].address)).to.equal(true);
    expect(await lens.isGenesisPeer(signers[0].address)).to.equal(true);
  });
});

describe("EvidenceConsensus — thresholds", () => {
  it("floors all thresholds at 1 with one peer", async () => {
    const { contract, gov } = await deploy(0, 1, false);
    // Percentage gates (no on-chain getter) — pinned via the JS mirror.
    expect(canonT(1, 1)).to.equal(1);
    expect(canonT(3, 1)).to.equal(1);
    expect(expelT(1)).to.equal(1);
    expect(deprecT(1, 1)).to.equal(1);
    expect(bundleT(1, 1)).to.equal(1);
    // On-chain getters that survive (used by the frontend read path / gov).
    expect(await contract.taxonomyThreshold()).to.equal(1n);
    expect(await contract.retireThreshold()).to.equal(1n);
    expect(await gov.nomineeThreshold()).to.equal(1n);
    expect(await gov.revokeThreshold()).to.equal(1n);
  });

  it("scales correctly for n=10 peers", async () => {
    const { contract, gov } = await deploy(0, 10, false);
    expect(await contract.activePeerCount()).to.equal(10n);
    expect(canonT(1, 10)).to.equal(6);  // ceil(10*0.60)
    expect(canonT(2, 10)).to.equal(6);  // ceil(10*0.55)
    expect(canonT(3, 10)).to.equal(6);  // ceil(10*0.51)
    expect(expelT(10)).to.equal(3);
    expect(deprecT(1, 10)).to.equal(7);
    expect(deprecT(2, 10)).to.equal(6);
    expect(deprecT(3, 10)).to.equal(6);
    expect(await gov.nomineeThreshold()).to.equal(4n);    // floor(10/3)+1
    expect(await contract.taxonomyThreshold()).to.equal(6n);   // floor(10/2)+1 (decoupled majority)
    expect(await gov.revokeThreshold()).to.equal(5n);
    // Founding-evidence gate is max(taxonomy majority, tier canonize) — now a majority.
    expect(bundleT(1, 10)).to.equal(6);    // max(6, 6)
    expect(bundleT(3, 10)).to.equal(6);    // max(6, 6)
  });

  it("ramps the admission threshold as floor(n/3)+1 (strictly > 1/3) with no cap", async () => {
    const { contract, gov } = await deploy(OPEN_SEED, 1, false);
    await padPeers(contract, 50);
    expect(await gov.nomineeThreshold()).to.equal(17n);  // floor(50/3)+1 = 17
    await padPeers(contract, 99);
    expect(await gov.nomineeThreshold()).to.equal(34n);  // floor(99/3)+1 = 34 (was ceil=33)
    await padPeers(contract, 100);
    expect(await gov.nomineeThreshold()).to.equal(34n);  // floor(100/3)+1 = 34
    await padPeers(contract, 120);
    expect(await gov.nomineeThreshold()).to.equal(41n);  // floor(120/3)+1 = 41 — uncapped
    expect(await contract.taxonomyThreshold()).to.equal(61n); // floor(120/2)+1 — decoupled majority
  });

  it("admission gate requires STRICTLY more than 1/3 (closes the exactly-1/3 capture)", async () => {
    const { contract, gov } = await deploy(OPEN_SEED, 1, false);
    await padPeers(contract, 9);
    expect(await gov.nomineeThreshold()).to.equal(4n);   // floor(9/3)+1 = 4, not 3
    await padPeers(contract, 12);
    expect(await gov.nomineeThreshold()).to.equal(5n);   // floor(12/3)+1 = 5, not 4
  });

  it("retireThreshold is a ceil(2n/3) supermajority, floored at 1", async () => {
    const { contract } = await deploy(0, 1, false);
    expect(await contract.retireThreshold()).to.equal(1n);     // ceil(2/3) floored
    const big = await deploy(OPEN_SEED, 1, false);
    await padPeers(big.contract, 10);
    expect(await big.contract.retireThreshold()).to.equal(7n); // ceil(20/3) = 7
  });
});

describe("EvidenceConsensus — seed-phase gating", () => {
  it("blocks nominatePeer when activePeerCount < seedPhaseK", async () => {
    const { gov, signers } = await deploy(5, 1, false);
    const [, target] = signers;
    await expect(
      nominateSigned(gov, signers[0], target.address, "Target")
    ).to.be.revertedWith("seed phase: owner must seed peers first");
  });

  it("owner can seed via addPeer during seed phase", async () => {
    const { contract, gov, signers } = await deploy(5, 1, false);
    const [, a, b] = signers;
    await contract.addPeer(a.address, "A");
    await contract.addPeer(b.address, "B");
    expect(await contract.activePeerCount()).to.equal(3n);
    expect(await gov.nominationsOpen()).to.equal(false);
  });

  it("blocks owner addPeer once the seed phase is over", async () => {
    const { contract, signers } = await deploy(2, 1, false);
    const [, a, b] = signers;
    await contract.addPeer(a.address, "A");          // count 2 == K
    await expect(contract.addPeer(b.address, "B"))
      .to.be.revertedWith("seed phase over");
  });

  it("unlocks nominations once K is reached", async () => {
    const { contract, gov, signers } = await deploy(3, 1, false);
    const [, a, b, target] = signers;
    await contract.addPeer(a.address, "A");
    await contract.addPeer(b.address, "B");
    expect(await gov.nominationsOpen()).to.equal(true);
    await expect(nominateSigned(gov, signers[0], target.address, "Target"))
      .to.emit(gov, "PeerNominated");
  });
});

describe("EvidenceConsensus — peer registry + swap-pop", () => {
  it("swap-pop preserves _peerList integrity across revocations", async () => {
    const { contract, gov, signers } = await deploy(0, 4, false);
    const [, a, b, c] = signers;
    expect(await contract.activePeerCount()).to.equal(4n);

    // n=4 → revokeThreshold = 2. Revoke the middle peer (b) via vote.
    await motionRevokeSigned(gov, signers[0], b.address);  // signer0 → 1
    await voteRevokeSigned(gov, c, b.address);             // → 2 → removed
    expect(await contract.activePeerCount()).to.equal(3n);
    expect(await contract.isActivePeer(b.address)).to.equal(false);

    const list = await contract.peerList();
    expect(list.length).to.equal(3);
    expect(list).to.include(signers[0].address);
    expect(list).to.include(a.address);
    expect(list).to.include(c.address);
    expect(list).to.not.include(b.address);
  });

  it("owner can re-add a revoked peer while still in seed phase", async () => {
    // K=3 with 3 genesis peers: revoking one drops count below K, re-opening
    // the seed phase so the owner can re-seed.
    const { contract, gov, signers } = await deploy(3, 3, false);
    const [, peer2, peer3] = signers;
    await motionRevokeSigned(gov, signers[0], peer3.address);  // signer0 → 1
    await voteRevokeSigned(gov, peer2, peer3.address);         // n=3 thr=2 → removed
    expect(await contract.isActivePeer(peer3.address)).to.equal(false);
    expect(await gov.revocationActive(peer3.address)).to.equal(false);

    await contract.addPeer(peer3.address, "peer3-readded");  // count 2 < K=3
    expect(await contract.isActivePeer(peer3.address)).to.equal(true);
    expect(await contract.peerHandle(peer3.address)).to.equal("peer3-readded");
    expect(await gov.revokeVoteCount(peer3.address)).to.equal(0);
  });

  it("rejects re-adding an already-active peer", async () => {
    const { contract, signers } = await deploy(5, 1, false);
    await expect(contract.addPeer(signers[0].address, "x"))
      .to.be.revertedWith("already active");
  });

  it("rejects zero address", async () => {
    const { contract } = await deploy(5, 1, false);
    await expect(contract.addPeer(ethers.ZeroAddress, "x"))
      .to.be.revertedWith("zero address");
  });
});

describe("EvidenceConsensus — nominee flow", () => {
  it("auto-promotes nominee on endorsement quorum and removes from nominee list", async () => {
    const { contract, gov, signers } = await deploy(2, 2, false); // n=2 → nominee thr=1
    const [, peer2, target] = signers;
    await nominateSigned(gov, peer2, target.address, "Target");

    let nominees = await gov.nomineeList();
    expect(nominees.length).to.equal(1);
    expect(nominees[0]).to.equal(target.address);

    await expect(endorseNomineeSigned(gov, signers[0], target.address))
      .to.emit(gov, "NomineeVerified");

    expect(await contract.isActivePeer(target.address)).to.equal(true);
    expect(await gov.isNominated(target.address)).to.equal(false);

    nominees = await gov.nomineeList();
    expect(nominees.length).to.equal(0);
  });

  it("prevents double-endorsement", async () => {
    const { contract, gov, signers } = await deploy(4, 4, false); // n=4 → nominee thr=2
    const target = signers[4];
    await nominateSigned(gov, signers[1], target.address, "T");
    await endorseNomineeSigned(gov, signers[0], target.address);   // signers[0] → 1
    await expect(endorseNomineeSigned(gov, signers[0], target.address))
      .to.be.revertedWith("already endorsed");
    await endorseNomineeSigned(gov, signers[1], target.address);   // → 2 → verified
    expect(await contract.isActivePeer(target.address)).to.equal(true);
  });

  it("rejects nominating an already-active peer", async () => {
    const { gov, signers } = await deploy(2, 2, false);
    const [, peer2] = signers;
    await expect(nominateSigned(gov, signers[0], peer2.address, "x"))
      .to.be.revertedWith("already a peer");
  });

  it("non-peer cannot nominate", async () => {
    const { gov, signers } = await deploy(0, 1, false);
    const [, outsider, target] = signers;
    await expect(
      nominateSigned(gov, outsider, target.address, "x")
    ).to.be.revertedWith("not an active peer");
  });
});

describe("EvidenceConsensus — revocation", () => {
  it("simple majority revokes and removes peer", async () => {
    const { contract, gov, signers } = await deploy(0, 3, false);
    const [, peer2, peer3] = signers;
    await motionRevokeSigned(gov, signers[0], peer3.address);
    await voteRevokeSigned(gov, peer2, peer3.address);
    expect(await contract.isActivePeer(peer3.address)).to.equal(false);
    expect(await contract.activePeerCount()).to.equal(2n);

    const list = await contract.peerList();
    expect(list).to.not.include(peer3.address);
  });

  it("self-revoke is blocked", async () => {
    const { gov, signers } = await deploy(0, 2, false);
    const [g] = signers;
    await expect(motionRevokeSigned(gov, g, g.address))
      .to.be.revertedWith("cannot self-revoke");
  });

  it("cannot double-motion", async () => {
    const { gov, signers } = await deploy(0, 5, false); // n=5 thr=3 → stays open
    const [, peer2, peer3] = signers;
    await motionRevokeSigned(gov, signers[0], peer3.address);
    await expect(motionRevokeSigned(gov, peer2, peer3.address))
      .to.be.revertedWith("revocation already active");
  });

  it("cannot double-vote on an open revocation motion", async () => {
    const { gov, signers } = await deploy(0, 5, false); // n=5 thr=3
    const [, peer2, peer3] = signers;
    await motionRevokeSigned(gov, signers[0], peer3.address);  // signer0 → 1
    await voteRevokeSigned(gov, peer2, peer3.address);         // → 2 (still < 3)
    await expect(voteRevokeSigned(gov, peer2, peer3.address))
      .to.be.revertedWith("already voted");
  });

  it("cancelStaleRevocation clears a motion after the window and frees a re-motion", async () => {
    const { gov, signers } = await deploy(0, 5, false); // n=5 thr=3
    const [, peer2, peer3] = signers;
    await motionRevokeSigned(gov, signers[0], peer3.address);  // signer0 → 1 (< 3)

    await expect(gov.cancelStaleRevocation(peer3.address))
      .to.be.revertedWith("window still open");

    await time.increase(REVOKE_WINDOW + 1);
    await expect(gov.cancelStaleRevocation(peer3.address))
      .to.emit(gov, "RevocationCancelled").withArgs(peer3.address);
    expect(await gov.revocationActive(peer3.address)).to.equal(false);
    expect(await gov.revokeVoteCount(peer3.address)).to.equal(0);

    // A fresh motion starts a new round, so signer0 (who voted last time) may
    // vote again — votes are not permanently locked across motions.
    await motionRevokeSigned(gov, peer2, peer3.address);    // peer2 → 1
    expect(await gov.hasVotedRevoke(peer3.address, signers[0].address)).to.equal(false);
    await expect(voteRevokeSigned(gov, signers[0], peer3.address)).to.not.be.reverted; // signer0 → 2
    expect(await gov.revokeVoteCount(peer3.address)).to.equal(2);
  });
});

describe("PeerGovernance — vote-by-signature", () => {
  it("rejects an endorsement whose signature is from another peer", async () => {
    const { gov, signers } = await deploy(4, 4, false); // n=4 → nominee thr 2
    const target  = signers[4];
    await nominateSigned(gov, signers[1], target.address, "T");
    // signers[0] submits, but the PeerVote was signed by signers[2] → mismatch.
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const round   = await gov.nomineeRound(target.address);
    const badSig  = await signPeerVote(signers[2], await gov.getAddress(), chainId, target.address, VK_NOMINEE, true, round, ZERO_HASH);
    await expect(gov.connect(signers[0]).endorseNominee(target.address, ZERO_HASH, badSig))
      .to.be.revertedWith("bad sig");
  });

  it("binds the deliberation note: a noteHash differing from the signed one is rejected", async () => {
    const { gov, signers } = await deploy(4, 4, false);
    const target  = signers[4];
    await nominateSigned(gov, signers[1], target.address, "T");
    const chainId    = Number((await ethers.provider.getNetwork()).chainId);
    const round      = await gov.nomineeRound(target.address);
    const signedNote = ethers.keccak256(ethers.toUtf8Bytes("strong public record"));
    const tampered   = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
    const sig = await signPeerVote(signers[0], await gov.getAddress(), chainId, target.address, VK_NOMINEE, true, round, signedNote);
    await expect(gov.connect(signers[0]).endorseNominee(target.address, tampered, sig))
      .to.be.revertedWith("bad sig");
    await expect(gov.connect(signers[0]).endorseNominee(target.address, signedNote, sig))
      .to.emit(gov, "PeerEndorsed");
  });

  it("accepts a discard vote signed + bound to the current round", async () => {
    const { contract, gov, signers } = await deploy(0, 3, false); // n=3 → revoke thr 2
    const [, peer2, peer3] = signers;
    await motionRevokeSigned(gov, signers[0], peer3.address); // discard #1
    await voteRevokeSigned(gov, peer2, peer3.address);        // discard #2 → removed
    expect(await contract.isActivePeer(peer3.address)).to.equal(false);
  });

  it("rejects a discard vote signed against a stale round", async () => {
    const { gov, signers } = await deploy(0, 5, false); // n=5 → thr 3, motion stays open
    const [, peer2, peer3] = signers;
    await motionRevokeSigned(gov, signers[0], peer3.address); // opens round 1
    const chainId  = Number((await ethers.provider.getNetwork()).chainId);
    const staleSig = await signPeerVote(peer2, await gov.getAddress(), chainId, peer3.address, VK_REVOKE, true, 0, ZERO_HASH);
    await expect(gov.connect(peer2).voteRevoke(peer3.address, ZERO_HASH, staleSig))
      .to.be.revertedWith("bad sig");
  });
});

describe("EvidenceConsensus — evidence submission + first binding", () => {
  it("rejects zero contentHash", async () => {
    const { contract } = await deploy();
    await expect(contract.submitEvidence(evidenceId(1), 2, DEFAULT_TOPIC, ZERO_HASH))
      .to.be.revertedWith("empty content hash");
  });

  it("rejects invalid tier", async () => {
    const { contract } = await deploy();
    await expect(contract.submitEvidence(evidenceId(1), 0, DEFAULT_TOPIC, contentHash("x")))
      .to.be.revertedWith("invalid tier");
    await expect(contract.submitEvidence(evidenceId(1), 4, DEFAULT_TOPIC, contentHash("x")))
      .to.be.revertedWith("invalid tier");
  });

  it("rejects an unratified topic", async () => {
    const { contract } = await deploy();
    await expect(contract.submitEvidence(evidenceId(1), 2, nodeId("nope"), contentHash("x")))
      .to.be.revertedWith("unratified topic");
    await expect(contract.submitEvidence(evidenceId(1), 2, DEFAULT_PILLAR, contentHash("x")))
      .to.be.revertedWith("unratified topic");
  });

  it("rejects duplicate evidence id", async () => {
    const { contract } = await deploy();
    const id = evidenceId(42);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("first"));
    await expect(contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("second")))
      .to.be.revertedWith("already submitted");
  });

  it("any wallet (non-peer) may submit and cross-list — it signs the tx itself", async () => {
    const { contract, signers } = await deploy();
    const stranger = signers[1]; // never added as a peer
    expect(await contract.isActivePeer(stranger.address)).to.equal(false);

    const id  = evidenceId(1);
    const ch  = contentHash("x");
    const bid = bindingId(id, DEFAULT_TOPIC);
    await expect(contract.connect(stranger).submitEvidence(id, 2, DEFAULT_TOPIC, ch))
      .to.emit(contract, "EvidenceSubmitted").withArgs(id, 2, stranger.address, ch)
      .and.to.emit(contract, "BindingSubmitted").withArgs(bid, id, DEFAULT_TOPIC, 2, stranger.address);

    // A non-peer is rate-limited between submissions; cross-listing is allowed
    // once the public submit cooldown elapses.
    await time.increase(10 * 60 + 1);
    const bid2 = bindingId(id, DEFAULT_TOPIC_2);
    await expect(contract.connect(stranger).fileBinding(id, DEFAULT_TOPIC_2))
      .to.emit(contract, "BindingSubmitted").withArgs(bid2, id, DEFAULT_TOPIC_2, 2, stranger.address);
  });

  it("emits EvidenceSubmitted + BindingSubmitted and records both", async () => {
    const { contract, signers } = await deploy();
    const id = evidenceId(7);
    const ch = contentHash("payload-v1");
    const bid = bindingId(id, DEFAULT_TOPIC);
    await expect(contract.submitEvidence(id, 1, DEFAULT_TOPIC, ch))
      .to.emit(contract, "EvidenceSubmitted").withArgs(id, 1, signers[0].address, ch)
      .and.to.emit(contract, "BindingSubmitted").withArgs(bid, id, DEFAULT_TOPIC, 1, signers[0].address);

    const ev = await contract.getEvidence(id);
    expect(ev.exists).to.equal(true);
    expect(ev.contentHash).to.equal(ch);
    expect(ev.tier).to.equal(1);
    expect(ev.bindingCount).to.equal(1n);

    const b = await contract.getBinding(id, DEFAULT_TOPIC);
    expect(b.state).to.equal(State.Submitted);
    expect(b.topicId).to.equal(DEFAULT_TOPIC);
    expect(b.evidenceId).to.equal(id);
  });
});

describe("EvidenceConsensus — multi-binding (cross-listing)", () => {
  it("fileBinding opens an independent binding under another topic", async () => {
    const { contract } = await deploy();
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    const bid2 = bindingId(id, DEFAULT_TOPIC_2);
    await expect(contract.fileBinding(id, DEFAULT_TOPIC_2))
      .to.emit(contract, "BindingSubmitted").withArgs(bid2, id, DEFAULT_TOPIC_2, 2, (await ethers.getSigners())[0].address);

    expect((await contract.getEvidence(id)).bindingCount).to.equal(2n);
    expect(await bindingState(contract, id, DEFAULT_TOPIC)).to.equal(State.Submitted);
    expect(await bindingState(contract, id, DEFAULT_TOPIC_2)).to.equal(State.Submitted);
  });

  it("fileBinding rejects unknown evidence and duplicate binding", async () => {
    const { contract } = await deploy();
    const id = evidenceId(1);
    await expect(contract.fileBinding(id, DEFAULT_TOPIC)).to.be.revertedWith("unknown evidence");
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    await expect(contract.fileBinding(id, DEFAULT_TOPIC)).to.be.revertedWith("binding active");
    await expect(contract.fileBinding(id, nodeId("nope"))).to.be.revertedWith("unratified topic");
  });

  it("each binding votes independently — one canon, one expelled", async () => {
    const { contract, signers } = await deploy(); // genesis-1, all thresholds = 1
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x")); // binding A
    await contract.fileBinding(id, DEFAULT_TOPIC_2);                        // binding B

    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true);    // canon A
    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC_2, false); // expel B

    expect(await bindingState(contract, id, DEFAULT_TOPIC)).to.equal(State.Canon);
    expect(await bindingState(contract, id, DEFAULT_TOPIC_2)).to.equal(State.Expelled);
  });

  it("the same peer can vote once per binding (votes are per binding, not per evidence)", async () => {
    const { contract, signers } = await deploy(0, 5); // tier-1 canon threshold = ceil(5*0.45)=3
    const id = evidenceId(1);
    await contract.submitEvidence(id, 1, DEFAULT_TOPIC, contentHash("x"));
    await contract.fileBinding(id, DEFAULT_TOPIC_2);

    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true);    // peer0 on A
    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC_2, true);  // peer0 on B — allowed
    await expect(reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true))
      .to.be.revertedWith("already voted");
  });
});

describe("EvidenceConsensus — submission queue (L2)", () => {
  it("throttles public (non-peer) submissions with the cooldown; peers are exempt", async () => {
    const { contract, signers } = await deploy(0, 5); // 5 peers → capacity 20
    const pub = signers[9]; // not a peer
    await contract.connect(pub).submitEvidence(evidenceId(1), 2, DEFAULT_TOPIC, contentHash("p1"));
    await expect(
      contract.connect(pub).submitEvidence(evidenceId(2), 2, DEFAULT_TOPIC, contentHash("p2")),
    ).to.be.revertedWith("submit cooldown active");
    await time.increase(10 * 60 + 1);
    await contract.connect(pub).submitEvidence(evidenceId(2), 2, DEFAULT_TOPIC, contentHash("p2")); // ok now

    // A peer is not throttled — two back-to-back submissions both succeed.
    await contract.connect(signers[0]).submitEvidence(evidenceId(3), 2, DEFAULT_TOPIC, contentHash("a"));
    await contract.connect(signers[0]).submitEvidence(evidenceId(4), 2, DEFAULT_TOPIC, contentHash("b"));
  });

  it("parks submissions in the queue once the active review set is full", async () => {
    const { contract } = await deploy(); // fixed cap → reviewCapacity = 3
    expect(await contract.reviewCapacity()).to.equal(3n);
    for (let i = 1; i <= 3; i++) {
      await contract.submitEvidence(evidenceId(i), 2, DEFAULT_TOPIC, contentHash("e" + i));
      expect(await bindingState(contract, evidenceId(i))).to.equal(State.Submitted);
    }
    expect(await contract.activeReviewCount()).to.equal(3n);
    // No slot left → next submission parks in the queue.
    await contract.submitEvidence(evidenceId(4), 2, DEFAULT_TOPIC, contentHash("e4"));
    expect(await bindingState(contract, evidenceId(4))).to.equal(State.Queued);
    expect(await contract.activeReviewCount()).to.equal(3n);
  });

  it("resolving a binding frees a slot for promotion", async () => {
    const { contract, signers } = await deploy(); // genesis-1, thresholds = 1, capacity 3
    for (let i = 1; i <= 3; i++)
      await contract.submitEvidence(evidenceId(i), 2, DEFAULT_TOPIC, contentHash("e" + i));
    await contract.submitEvidence(evidenceId(4), 2, DEFAULT_TOPIC, contentHash("e4")); // queued
    expect(await bindingState(contract, evidenceId(4))).to.equal(State.Queued);

    // No free slot yet → promote reverts.
    await expect(contract.promote(evidenceId(4), DEFAULT_TOPIC)).to.be.revertedWith("no review slot");

    // Canonize one active binding → frees a slot.
    await reviewVote(contract, signers[0], evidenceId(1), DEFAULT_TOPIC, true);
    expect(await contract.activeReviewCount()).to.equal(2n);

    await contract.promote(evidenceId(4), DEFAULT_TOPIC);
    expect(await bindingState(contract, evidenceId(4))).to.equal(State.Submitted);
    expect(await contract.activeReviewCount()).to.equal(3n);
  });

  it("a queued binding never lapses (its review clock is unset)", async () => {
    const { contract } = await deploy();
    for (let i = 1; i <= 3; i++)
      await contract.submitEvidence(evidenceId(i), 2, DEFAULT_TOPIC, contentHash("e" + i));
    await contract.submitEvidence(evidenceId(4), 2, DEFAULT_TOPIC, contentHash("e4")); // queued
    await time.increase(PENDING_WINDOW + 1);
    await expect(contract.markLapsed(evidenceId(4), DEFAULT_TOPIC)).to.be.revertedWith("not pending");
    expect(await bindingState(contract, evidenceId(4))).to.equal(State.Queued);
  });

  it("founding bindings open straight into Canon and never occupy a review slot", async () => {
    const { contract } = await deploy(); // seeding canonizes 2 founding bindings
    expect(await contract.activeReviewCount()).to.equal(0n);
  });
});

describe("EvidenceConsensus — public boost (L2)", () => {
  const BOOST_COOLDOWN = 10 * 60; // 10 minutes, mirrors the contract constant

  async function deployWithQueued() {
    const ctx = await deploy(); // genesis-1, capacity 4
    // 1-4 enter active review (capacity 4); 5 & 6 stay queued.
    for (let i = 1; i <= 6; i++)
      await ctx.contract.submitEvidence(evidenceId(i), 2, DEFAULT_TOPIC, contentHash("e" + i));
    return ctx;
  }

  it("anyone can boost a queued binding once", async () => {
    const { contract, signers } = await deployWithQueued();
    const pub = signers[7]; // not a peer
    await expect(contract.connect(pub).boostQueued(evidenceId(5), DEFAULT_TOPIC))
      .to.emit(contract, "QueueBoosted");
    await expect(contract.connect(pub).boostQueued(evidenceId(5), DEFAULT_TOPIC))
      .to.be.revertedWith("already boosted");
  });

  it("enforces a per-wallet boost cooldown for the public", async () => {
    const { contract, signers } = await deployWithQueued();
    const pub = signers[7];
    await contract.connect(pub).boostQueued(evidenceId(5), DEFAULT_TOPIC); // sets the clock
    // A different binding is blocked while the cooldown is active.
    await expect(contract.connect(pub).boostQueued(evidenceId(6), DEFAULT_TOPIC))
      .to.be.revertedWith("boost cooldown active");
    await time.increase(BOOST_COOLDOWN + 1);
    await expect(contract.connect(pub).boostQueued(evidenceId(6), DEFAULT_TOPIC))
      .to.emit(contract, "QueueBoosted");
  });

  it("active peers are exempt from the boost cooldown", async () => {
    const { contract, signers } = await deployWithQueued();
    const peer = signers[0]; // genesis peer
    await expect(contract.connect(peer).boostQueued(evidenceId(5), DEFAULT_TOPIC))
      .to.emit(contract, "QueueBoosted");
    // No cooldown wait needed between distinct bindings for a peer.
    await expect(contract.connect(peer).boostQueued(evidenceId(6), DEFAULT_TOPIC))
      .to.emit(contract, "QueueBoosted");
  });

  it("cannot boost a binding that is not queued", async () => {
    const { contract } = await deploy();
    await contract.submitEvidence(evidenceId(1), 2, DEFAULT_TOPIC, contentHash("e1")); // Submitted
    await expect(contract.boostQueued(evidenceId(1), DEFAULT_TOPIC))
      .to.be.revertedWith("not queued");
  });
});

describe("EvidenceConsensus — peer garbage collection (L2)", () => {
  const INACTIVITY_WINDOW = 30 * DAY;

  it("prunes a peer idle past the inactivity window; reverts before it", async () => {
    const { contract, signers } = await deploy(0, 4); // 4 peers, seedPhaseK 0 → above floor
    const victim = signers[3];
    await expect(contract.pruneInactivePeer(victim.address)).to.be.revertedWith("still active");
    await time.increase(INACTIVITY_WINDOW + 1);
    await expect(contract.pruneInactivePeer(victim.address)).to.emit(contract, "PeerRemoved");
    expect(await contract.isActivePeer(victim.address)).to.equal(false);
    expect(await contract.activePeerCount()).to.equal(3n);
  });

  it("heartbeat resets the inactivity clock", async () => {
    const { contract, signers } = await deploy(0, 4);
    const victim = signers[3];
    await time.increase(INACTIVITY_WINDOW - DAY);
    await contract.connect(victim).heartbeat();
    await time.increase(2 * DAY); // > window since deploy, but < window since heartbeat
    await expect(contract.pruneInactivePeer(victim.address)).to.be.revertedWith("still active");
  });

  it("casting a review vote resets the inactivity clock", async () => {
    const { contract, signers } = await deploy(0, 4); // capacity 16
    const victim = signers[3];
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    await time.increase(INACTIVITY_WINDOW - DAY); // still inside the 30-day review window
    await reviewVote(contract, victim, id, DEFAULT_TOPIC, true);
    await time.increase(2 * DAY);
    await expect(contract.pruneInactivePeer(victim.address)).to.be.revertedWith("still active");
  });

  it("never prunes below the seed-phase floor", async () => {
    const { contract, signers } = await deploy(4, 4); // seedPhaseK == activePeerCount == 4
    const victim = signers[3];
    await time.increase(INACTIVITY_WINDOW + 1);
    await expect(contract.pruneInactivePeer(victim.address)).to.be.revertedWith("at peer floor");
  });

  it("rejects pruning a non-peer", async () => {
    const { contract, signers } = await deploy(0, 4);
    await time.increase(INACTIVITY_WINDOW + 1);
    await expect(contract.pruneInactivePeer(signers[9].address)).to.be.revertedWith("not active peer");
  });
});

describe("EvidenceConsensus — review voting", () => {
  it("canonizes a binding on approve threshold (Genesis-1, threshold=1)", async () => {
    const { contract, signers } = await deploy();
    const id = evidenceId(1);
    const bid = bindingId(id, DEFAULT_TOPIC);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    await expect(reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true))
      .to.emit(contract, "BindingCanonized").withArgs(bid, id, DEFAULT_TOPIC, anyUint(), 1);
    expect(await bindingState(contract, id)).to.equal(State.Canon);
  });

  it("expels a binding on reject threshold (Genesis-1, threshold=1)", async () => {
    const { contract, signers } = await deploy();
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC, false);
    expect(await bindingState(contract, id)).to.equal(State.Expelled);
  });

  it("prevents double-voting on a binding", async () => {
    const { contract, signers } = await deploy(0, 5);
    const id = evidenceId(1);
    await contract.submitEvidence(id, 1, DEFAULT_TOPIC, contentHash("x"));
    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true);
    await expect(reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true))
      .to.be.revertedWith("already voted");
  });

  it("cannot vote after canonization", async () => {
    // n=3, tier2 → canonize = ceil(3*0.55) = 2; two approves canonize, a third reverts.
    const { contract, signers } = await deploy(0, 3);
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true);
    await reviewVote(contract, signers[1], id, DEFAULT_TOPIC, true); // canonizes
    await expect(reviewVote(contract, signers[2], id, DEFAULT_TOPIC, true))
      .to.be.revertedWith("not in review");
  });

  it("voting an unknown binding reverts (not in review)", async () => {
    const { contract, signers } = await deploy();
    await expect(reviewVote(contract, signers[0], evidenceId(9), DEFAULT_TOPIC, true))
      .to.be.revertedWith("not in review");
  });

  it("review votes are rejected after the pending window closes (L1)", async () => {
    const { contract, signers } = await deploy();
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    await time.increase(PENDING_WINDOW + 1);
    await expect(reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true))
      .to.be.revertedWith("review window closed");
  });

  it("markLapsed flips a binding only after the window and is permissionless", async () => {
    const { contract, signers } = await deploy();
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    await expect(contract.markLapsed(id, DEFAULT_TOPIC))
      .to.be.revertedWith("window still open");
    await time.increase(PENDING_WINDOW + 1);
    await expect(contract.connect(signers[9]).markLapsed(id, DEFAULT_TOPIC))
      .to.emit(contract, "BindingLapsed");
    expect(await bindingState(contract, id)).to.equal(State.Lapsed);
  });
});

describe("EvidenceConsensus — challenge lifecycle", () => {
  async function canonized(contract, signers, tier = 2, seed = 1, topicId = DEFAULT_TOPIC) {
    const id = evidenceId(seed);
    if (!(await contract.getEvidence(id)).exists) {
      await contract.submitEvidence(id, tier, topicId, contentHash("x" + seed));
    } else {
      await contract.fileBinding(id, topicId);
    }
    const n = Number(await contract.activePeerCount());
    const threshold = canonT(tier, n);
    for (let i = 0; i < threshold && i < n; i++) {
      await reviewVote(contract, signers[i], id, topicId, true);
    }
    return id;
  }

  it("opens challenge, deprecates immediately when threshold met (Genesis-1, threshold=1)", async () => {
    const { contract, signers } = await deploy();
    const id = await canonized(contract, signers);
    await expect(openChallengeSigned(contract, signers[0], id, DEFAULT_TOPIC))
      .to.emit(contract, "ChallengeOpened")
      .and.to.emit(contract, "BindingDeprecated");
    expect(await bindingState(contract, id)).to.equal(State.Deprecated);
  });

  it("reaffirms via window expiry when challenge < threshold", async () => {
    const { contract, signers } = await deploy(0, 3);
    const id = await canonized(contract, signers, 2);
    await openChallengeSigned(contract, signers[0], id, DEFAULT_TOPIC);
    expect(await bindingState(contract, id)).to.equal(State.Contested);

    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(contract.finalizeChallenge(id, DEFAULT_TOPIC))
      .to.emit(contract, "BindingReaffirmed");
    expect(await bindingState(contract, id)).to.equal(State.Reaffirmed);
  });

  it("reaffirms even with zero defense votes (silence ≠ deprecation)", async () => {
    const { contract, signers } = await deploy(0, 3);
    const id = await canonized(contract, signers, 2);
    await openChallengeSigned(contract, signers[1], id, DEFAULT_TOPIC);
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(contract.finalizeChallenge(id, DEFAULT_TOPIC))
      .to.emit(contract, "BindingReaffirmed");
    expect(await bindingState(contract, id)).to.equal(State.Reaffirmed);
  });

  it("anyone can call finalizeChallenge after window", async () => {
    const { contract, signers } = await deploy(0, 3);
    const id = await canonized(contract, signers, 2);
    await openChallengeSigned(contract, signers[0], id, DEFAULT_TOPIC);
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(contract.connect(signers[7]).finalizeChallenge(id, DEFAULT_TOPIC))
      .to.not.be.reverted;
  });

  it("blocks finalize while window still open", async () => {
    const { contract, signers } = await deploy(0, 3);
    const id = await canonized(contract, signers, 2);
    await openChallengeSigned(contract, signers[0], id, DEFAULT_TOPIC);
    await expect(contract.finalizeChallenge(id, DEFAULT_TOPIC))
      .to.be.revertedWith("window still open");
  });

  it("cannot vote on challenge after window expires", async () => {
    const { contract, signers } = await deploy(0, 5);
    const id = await canonized(contract, signers, 2);
    await openChallengeSigned(contract, signers[0], id, DEFAULT_TOPIC);
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(challengeVote(contract, signers[1], id, DEFAULT_TOPIC, false))
      .to.be.revertedWith("window expired");
  });

  it("only a canon/reaffirmed binding can be challenged", async () => {
    const { contract, signers } = await deploy();
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x")); // Submitted, not canon
    await expect(openChallengeSigned(contract, signers[0], id, DEFAULT_TOPIC)).to.be.revertedWith("not canon");
  });

  it("enforces 7-day per-peer challenge cooldown (across bindings)", async () => {
    const { contract, signers } = await deploy(0, 5);
    const id1 = await canonized(contract, signers, 2, 1);
    const id2 = await canonized(contract, signers, 2, 2);

    await openChallengeSigned(contract, signers[0], id1, DEFAULT_TOPIC);
    await expect(openChallengeSigned(contract, signers[0], id2, DEFAULT_TOPIC))
      .to.be.revertedWith("challenge cooldown active");

    await time.increase(CHALLENGE_COOLDOWN + 1);
    await expect(openChallengeSigned(contract, signers[0], id2, DEFAULT_TOPIC)).to.not.be.reverted;
  });

  it("blocks re-challenging a binding until the per-binding cooldown elapses (L3)", async () => {
    const { contract, signers } = await deploy(0, 3);
    const id = await canonized(contract, signers, 2);
    await openChallengeSigned(contract, signers[0], id, DEFAULT_TOPIC);
    await time.increase(CHALLENGE_WINDOW + 1);
    await contract.finalizeChallenge(id, DEFAULT_TOPIC); // reaffirmed
    // A different peer tries to immediately re-contest — too soon.
    await expect(openChallengeSigned(contract, signers[1], id, DEFAULT_TOPIC))
      .to.be.revertedWith("rechallenge cooldown active");
  });

  it("re-contest starts a fresh round: counters reset AND prior voters may vote again (M1)", async () => {
    const { contract, signers } = await deploy(0, 5);
    const id = await canonized(contract, signers, 2, 1); // deprecate2@5 = 3

    // Round 1: challenger signer0, defender signer1.
    await openChallengeSigned(contract, signers[0], id, DEFAULT_TOPIC);              // cv=1
    await challengeVote(contract, signers[1], id, DEFAULT_TOPIC, false);             // dv=1
    let b = await contract.getBinding(id, DEFAULT_TOPIC);
    expect(b.challengeVotes).to.equal(1);
    expect(b.defenseVotes).to.equal(1);
    expect(b.challengeRound).to.equal(1);

    await time.increase(CHALLENGE_WINDOW + 1);
    await contract.finalizeChallenge(id, DEFAULT_TOPIC);
    expect(await bindingState(contract, id)).to.equal(State.Reaffirmed);

    // Wait out the per-binding re-challenge cooldown, then re-contest.
    await time.increase(RECHALLENGE_COOLDOWN + 1);
    await openChallengeSigned(contract, signers[2], id, DEFAULT_TOPIC);             // round 2, cv=1
    b = await contract.getBinding(id, DEFAULT_TOPIC);
    expect(b.state).to.equal(State.Contested);
    expect(b.challengeVotes).to.equal(1);
    expect(b.defenseVotes).to.equal(0);
    expect(b.challengeRound).to.equal(2);

    // signer0 voted in round 1; under per-round eligibility it can vote in round 2.
    expect(await contract.hasVoted(bindingId(id, DEFAULT_TOPIC), 1, signers[0].address)).to.equal(false);
    await expect(challengeVote(contract, signers[0], id, DEFAULT_TOPIC, true)).to.not.be.reverted; // cv=2
    b = await contract.getBinding(id, DEFAULT_TOPIC);
    expect(b.challengeVotes).to.equal(2);
  });
});

describe("EvidenceConsensus — two-step ownership", () => {
  it("proposeOwner sets pendingOwner without changing owner", async () => {
    const { contract, signers } = await deploy();
    const [g, next] = signers;
    await expect(contract.proposeOwner(next.address))
      .to.emit(contract, "OwnershipProposed").withArgs(g.address, next.address);
    expect(await contract.owner()).to.equal(g.address);
    expect(await contract.pendingOwner()).to.equal(next.address);
  });

  it("acceptOwnership must be called by pendingOwner", async () => {
    const { contract, signers } = await deploy();
    const [, next, outsider] = signers;
    await contract.proposeOwner(next.address);
    await expect(contract.connect(outsider).acceptOwnership())
      .to.be.revertedWith("not pending owner");
    await expect(contract.connect(next).acceptOwnership())
      .to.emit(contract, "OwnershipTransferred");
    expect(await contract.owner()).to.equal(next.address);
    expect(await contract.pendingOwner()).to.equal(ethers.ZeroAddress);
  });

  it("cancelOwnershipTransfer clears pendingOwner", async () => {
    const { contract, signers } = await deploy();
    const [, next] = signers;
    await contract.proposeOwner(next.address);
    await expect(contract.cancelOwnershipTransfer())
      .to.emit(contract, "OwnershipTransferCancelled");
    expect(await contract.pendingOwner()).to.equal(ethers.ZeroAddress);
    await expect(contract.connect(next).acceptOwnership())
      .to.be.revertedWith("not pending owner");
  });

  it("rejects proposing zero address or current owner", async () => {
    const { contract, signers } = await deploy();
    await expect(contract.proposeOwner(ethers.ZeroAddress))
      .to.be.revertedWith("zero address");
    await expect(contract.proposeOwner(signers[0].address))
      .to.be.revertedWith("already owner");
  });

  it("non-owner cannot propose", async () => {
    const { contract, signers } = await deploy();
    await expect(contract.connect(signers[1]).proposeOwner(signers[2].address))
      .to.be.revertedWith("not owner");
  });
});

describe("EvidenceConsensus — renounce ownership (trustless)", () => {
  it("renounces once the seed phase is complete and disables all owner powers", async () => {
    const { contract, signers } = await deploy(2, 2, false); // count 2 >= K 2
    await expect(contract.renounceOwnership())
      .to.emit(contract, "OwnershipTransferred").withArgs(signers[0].address, ethers.ZeroAddress);
    expect(await contract.owner()).to.equal(ethers.ZeroAddress);
    await expect(contract.pause()).to.be.revertedWith("not owner");
    await expect(contract.addPeer(signers[3].address, "x")).to.be.revertedWith("not owner");
  });

  it("blocks renounce during the seed phase", async () => {
    const { contract } = await deploy(5, 1, false); // count 1 < K 5
    await expect(contract.renounceOwnership())
      .to.be.revertedWith("seed phase not complete");
  });

  it("blocks renounce while paused (cannot brick the contract)", async () => {
    const { contract } = await deploy(2, 2, false);
    await contract.pause();
    await expect(contract.renounceOwnership()).to.be.revertedWith("paused");
  });
});

describe("EvidenceConsensus — peer-floor invariant", () => {
  it("revocation cannot reduce the active set below one peer", async () => {
    const { contract, gov, signers } = await deploy(0, 2, false);
    const [g, peer2] = signers;
    // n=2 → revokeThreshold 1, so a single motion removes the target.
    await motionRevokeSigned(gov, peer2, g.address);
    expect(await contract.isActivePeer(g.address)).to.equal(false);
    expect(await contract.activePeerCount()).to.equal(1n);
    // Only peer2 remains; no second peer exists to motion against it, so the
    // set can never drop to zero through the public API.
    expect(await contract.isActivePeer(peer2.address)).to.equal(true);
  });
});

describe("EvidenceConsensus — pause", () => {
  it("blocks state-changing peer calls when paused", async () => {
    const { contract } = await deploy();
    await contract.pause();
    await expect(contract.submitEvidence(evidenceId(1), 2, DEFAULT_TOPIC, contentHash("x")))
      .to.be.revertedWith("paused");
    await contract.unpause();
    await expect(contract.submitEvidence(evidenceId(1), 2, DEFAULT_TOPIC, contentHash("x")))
      .to.not.be.reverted;
  });

  it("non-owner cannot pause", async () => {
    const { contract, signers } = await deploy();
    await expect(contract.connect(signers[1]).pause())
      .to.be.revertedWith("not owner");
  });
});

describe("EvidenceConsensus — batched review voting", () => {
  it("castReviewVoteBatch records each binding vote like the single-vote path", async () => {
    const { contract, signers } = await deploy(0, 1);
    const id = evidenceId(101);
    await contract.submitEvidence(id, 3, DEFAULT_TOPIC, contentHash(id));
    await contract.fileBinding(id, DEFAULT_TOPIC_2);
    const id2 = evidenceId(102);
    await contract.submitEvidence(id2, 3, DEFAULT_TOPIC, contentHash(id2));

    await reviewVoteBatch(
      contract, signers[0],
      [id, id, id2],
      [DEFAULT_TOPIC, DEFAULT_TOPIC_2, DEFAULT_TOPIC],
      [true, false, true],
    );

    expect(await bindingState(contract, id, DEFAULT_TOPIC)).to.equal(State.Canon);
    expect(await bindingState(contract, id, DEFAULT_TOPIC_2)).to.equal(State.Expelled);
    expect(await bindingState(contract, id2, DEFAULT_TOPIC)).to.equal(State.Canon);
  });

  it("rejects mismatched array lengths", async () => {
    const { contract, signers } = await deploy(0, 1);
    const id = evidenceId(200);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    // ids/topics/noteHashes/sigs are length 1, but approves is length 2.
    await expect(reviewVoteBatch(contract, signers[0], [id], [DEFAULT_TOPIC], [true, false]))
      .to.be.revertedWith("length mismatch");
  });

  it("rejects empty batch", async () => {
    const { contract, signers } = await deploy(0, 1);
    await expect(reviewVoteBatch(contract, signers[0], [], [], []))
      .to.be.revertedWith("empty batch");
  });

  it("rejects oversize batch (> MAX_REVIEW_BATCH)", async () => {
    const { contract, signers } = await deploy(0, 1);
    const ids = Array.from({ length: 51 }, (_, i) => evidenceId(300 + i));
    const topics = Array.from({ length: 51 }, () => DEFAULT_TOPIC);
    const approves = Array.from({ length: 51 }, () => true);
    await expect(reviewVoteBatch(contract, signers[0], ids, topics, approves))
      .to.be.revertedWith("batch too large");
  });

  it("reverts atomically: one bad binding rolls back the whole batch", async () => {
    const { contract, signers } = await deploy(0, 1);
    const good = evidenceId(400);
    const bad  = evidenceId(401); // not submitted
    await contract.submitEvidence(good, 2, DEFAULT_TOPIC, contentHash("g"));
    await expect(reviewVoteBatch(contract, signers[0], [good, bad], [DEFAULT_TOPIC, DEFAULT_TOPIC], [true, true]))
      .to.be.revertedWith("not in review");
    expect(await bindingState(contract, good)).to.equal(State.Submitted);
  });

  it("rejects double-voting inside a single batch", async () => {
    const { contract, signers } = await deploy(0, 3);
    const id = evidenceId(500);
    await contract.submitEvidence(id, 1, DEFAULT_TOPIC, contentHash("d"));
    await expect(reviewVoteBatch(contract, signers[0], [id, id], [DEFAULT_TOPIC, DEFAULT_TOPIC], [true, false]))
      .to.be.revertedWith("already voted");
  });
});

describe("EvidenceConsensus — handle length cap", () => {
  it("constructor rejects an oversize genesis handle", async () => {
    const [a] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EvidenceConsensus");
    await expect(Factory.deploy([a.address], ["x".repeat(65)], 0))
      .to.be.revertedWith("handle too long");
  });

  it("addPeer rejects an oversize handle", async () => {
    const { contract, signers } = await deploy(5, 1, false);
    const [, a] = signers;
    await expect(contract.addPeer(a.address, "x".repeat(65)))
      .to.be.revertedWith("handle too long");
  });

  it("nominatePeer rejects an oversize handle", async () => {
    const { gov, signers } = await deploy(0, 1, false);
    const [, target] = signers;
    await expect(nominateSigned(gov, signers[0], target.address, "x".repeat(65)))
      .to.be.revertedWith("handle too long");
  });

  it("accepts a 64-byte handle exactly at the cap", async () => {
    const { contract, signers } = await deploy(5, 1, false);
    const [, a] = signers;
    const atCap = "x".repeat(64);
    await expect(contract.addPeer(a.address, atCap)).to.not.be.reverted;
    expect(await contract.peerHandle(a.address)).to.equal(atCap);
  });
});

describe("EvidenceConsensus — aggregated views", () => {
  it("getActivePeers (Lens) returns parallel arrays for all active peers", async () => {
    const { contract, lens, signers } = await deploy(5, 1, false);
    const [, a, b] = signers;
    await contract.addPeer(a.address, "Alice");
    await contract.addPeer(b.address, "Bob");

    const [addrs, handles, revActive, revVotes, lastActives] = await lens.getActivePeers();
    expect(addrs.length).to.equal(3);
    expect(handles.length).to.equal(3);
    expect(revActive.length).to.equal(3);
    expect(revVotes.length).to.equal(3);
    expect(lastActives.length).to.equal(3);
    lastActives.forEach(t => expect(t).to.be.greaterThan(0n)); // liveness clock set on admission
    const map = Object.fromEntries(addrs.map((a, i) => [a, handles[i]]));
    expect(map[a.address]).to.equal("Alice");
    expect(map[b.address]).to.equal("Bob");
  });

  it("getNominees (Lens) returns nominees with endorsement counts", async () => {
    const { gov, lens, signers } = await deploy(5, 5, false);
    const target = signers[5];
    await nominateSigned(gov, signers[0], target.address, "T");
    const [addrs, handles, endorsements] = await lens.getNominees();
    expect(addrs).to.deep.equal([target.address]);
    expect(handles).to.deep.equal(["T"]);
    expect(endorsements.map(Number)).to.deep.equal([0]);
  });
});

describe("EvidenceConsensus — content hash binding", () => {
  it("hash binds content only — cross-listing under another topic keeps the same hash", async () => {
    const { contract } = await deploy();
    const id  = evidenceId(99);
    const ch  = contentHash("Title|Source|2026|excerpt");
    await contract.submitEvidence(id, 1, DEFAULT_TOPIC, ch);
    await contract.fileBinding(id, DEFAULT_TOPIC_2);
    const ev = await contract.getEvidence(id);
    expect(ev.contentHash).to.equal(ch);
    expect(ev.bindingCount).to.equal(2n);
  });

  it("bindingId is keccak256(abi.encode(id, topicId))", async () => {
    const { contract } = await deploy();
    const id = evidenceId(1);
    expect(await contract.bindingId(id, DEFAULT_TOPIC)).to.equal(bindingId(id, DEFAULT_TOPIC));
  });
});

describe("EvidenceConsensus — taxonomy governance", () => {
  const PILLAR = nodeId("psychic-abilities");
  const FT     = nodeId("psychic-founding-topic"); // founding child topic bundled with the pillar
  const TOPIC  = nodeId("telepathy");
  const META_P = contentHash("psychic-abilities-meta");
  const META_FT= contentHash("psychic-founding-topic-meta");
  const META_T = contentHash("telepathy-meta");
  const EV_FP  = evidenceId(70001);                // founding evidence of the pillar's topic
  const EV_T   = evidenceId(70002);                // founding evidence of TOPIC
  const CH     = contentHash("founding-payload");

  // Sign with the connected contract's runner (signers[0] for the bare contract,
  // or whoever it was .connect()-ed to) so existing call sites stay unchanged.
  const propPillar = (c, p = PILLAR, ft = FT, ev = EV_FP) =>
    proposePillarSigned(c, c.runner, p, META_P, ft, META_FT, ev, 2, CH);
  const propTopic = (c, t = TOPIC, parent = PILLAR, ev = EV_T) =>
    proposeTopicSigned(c, c.runner, t, parent, META_T, ev, 2, CH);

  it("proposePillar ratifies the pillar + founding topic + evidence at quorum=1", async () => {
    const { contract, signers } = await deploy(0, 1, false);
    await expect(propPillar(contract))
      .to.emit(contract, "PillarProposed").withArgs(PILLAR, META_P, signers[0].address, 1n)
      .and.to.emit(contract, "PillarRatified").withArgs(PILLAR, META_P)
      .and.to.emit(contract, "TopicRatified").withArgs(FT, PILLAR, META_FT)
      .and.to.emit(contract, "EvidenceSubmitted").withArgs(EV_FP, 2, signers[0].address, CH)
      .and.to.emit(contract, "BindingCanonized");
    const node = await contract.getTaxonomyNode(PILLAR);
    expect(node.kind).to.equal(NodeKind.Pillar);
    expect(node.state).to.equal(NodeState.Ratified);
    expect(node.endorsements).to.equal(1n);
    expect(await contract.pillarIds()).to.deep.equal([PILLAR]);
    expect(await contract.topicIds(PILLAR)).to.deep.equal([FT]);
    expect((await contract.getEvidence(EV_FP)).exists).to.equal(true);
    expect(await bindingState(contract, EV_FP, FT)).to.equal(State.Canon);
  });

  it("proposeTopic requires a ratified pillar parent", async () => {
    const { contract } = await deploy(0, 1, false);
    await expect(propTopic(contract)).to.be.revertedWith("bad parent");
    await propPillar(contract);
    await expect(propTopic(contract))
      .to.emit(contract, "TopicRatified").withArgs(TOPIC, PILLAR, META_T)
      .and.to.emit(contract, "BindingCanonized");
    expect(await contract.topicIds(PILLAR)).to.deep.equal([FT, TOPIC]);
    expect(await bindingState(contract, EV_T, TOPIC)).to.equal(State.Canon);
  });

  it("a topic cannot be used as a parent pillar", async () => {
    const { contract } = await deploy(0, 1, false);
    await propPillar(contract);
    await propTopic(contract);
    await expect(proposeTopicSigned(contract, contract.runner,nodeId("sub"), TOPIC, contentHash("x"), evidenceId(70003), 2, CH))
      .to.be.revertedWith("bad parent");
  });

  it("rejects duplicate node ids", async () => {
    const { contract } = await deploy(0, 1, false);
    await propPillar(contract);
    await expect(propPillar(contract, PILLAR, nodeId("other-topic"), evidenceId(70009)))
      .to.be.revertedWith("node exists");
  });

  it("rejects zero id / empty meta hash", async () => {
    const { contract } = await deploy(0, 1, false);
    await expect(proposePillarSigned(contract, contract.runner,ZERO_HASH, META_P, FT, META_FT, EV_FP, 2, CH))
      .to.be.revertedWith("zero id");
    await expect(proposePillarSigned(contract, contract.runner,PILLAR, ZERO_HASH, FT, META_FT, EV_FP, 2, CH))
      .to.be.revertedWith("empty meta hash");
  });

  it("non-peer cannot propose or endorse", async () => {
    const { contract, signers } = await deploy(0, 1, false);
    await expect(propPillar(contract.connect(signers[1])))
      .to.be.revertedWith("not an active peer");
    await propPillar(contract);
    await expect(endorseNodeSigned(contract, signers[1], PILLAR))
      .to.be.revertedWith("not an active peer");
  });

  it("multi-peer: needs threshold endorsements to ratify; proposer counts as #1", async () => {
    const { contract, signers } = await deploy(0, 4, false); // bundleThreshold(2)@4 = 3
    await expect(propPillar(contract))
      .to.emit(contract, "PillarProposed")
      .and.to.not.emit(contract, "PillarRatified");
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Proposed);
    // The bundled founding topic/evidence don't materialize until ratification.
    expect((await contract.getTaxonomyNode(FT)).state).to.equal(NodeState.None);
    expect((await contract.getEvidence(EV_FP)).exists).to.equal(false);
    expect(await contract.topicReserved(FT)).to.equal(true);
    expect(await contract.evidenceReserved(EV_FP)).to.equal(true);

    await expect(endorseNodeSigned(contract, contract.runner, PILLAR)).to.be.revertedWith("already endorsed");

    await endorseNodeSigned(contract, signers[1], PILLAR); // → 2, still below the majority gate
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Proposed);

    await expect(endorseNodeSigned(contract, signers[2], PILLAR)) // → 3, ratifies
      .to.emit(contract, "PillarRatified").withArgs(PILLAR, META_P)
      .and.to.emit(contract, "TopicRatified").withArgs(FT, PILLAR, META_FT)
      .and.to.emit(contract, "BindingCanonized");
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Ratified);
    expect(await bindingState(contract, EV_FP, FT)).to.equal(State.Canon);
    expect(await contract.topicReserved(FT)).to.equal(false);
    expect(await contract.evidenceReserved(EV_FP)).to.equal(false);
  });

  it("founding evidence is gated at the tier's canonize threshold, not just taxonomy (M2)", async () => {
    // n=15: taxonomyThreshold = floor(15/2)+1 = 8, canonizeThreshold(1) = ceil(15*0.60) = 9
    // → bundle gate = max(8, 9) = 9, strictly above the bare taxonomy majority.
    const { contract, signers } = await deploy(0, 15, false);
    expect(await contract.taxonomyThreshold()).to.equal(8n);
    expect(canonT(1, 15)).to.equal(9);
    expect(bundleT(1, 15)).to.equal(9);
    await proposePillarSigned(contract, contract.runner,PILLAR, META_P, FT, META_FT, EV_FP, 1, CH); // proposer = #1
    for (let i = 1; i <= 7; i++) await endorseNodeSigned(contract, signers[i], PILLAR); // → 8
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Proposed); // 8 (taxonomy) < 9 (bundle)
    await endorseNodeSigned(contract, signers[8], PILLAR);                              // → 9
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Ratified);
  });

  it("endorseNode on an unknown / settled node reverts", async () => {
    const { contract } = await deploy(0, 1, false);
    await expect(endorseNodeSigned(contract, contract.runner, PILLAR)).to.be.revertedWith("not proposed");
    await propPillar(contract);
    await expect(endorseNodeSigned(contract, contract.runner, PILLAR)).to.be.revertedWith("not proposed");
  });

  it("getProposedNodes (Lens) lists only the proposed node (not the bundled topic) and clears on ratify", async () => {
    const { contract, lens, signers } = await deploy(0, 4, false); // threshold 3
    await propPillar(contract);
    const [ids, kinds, parents, metas, proposers, ends, rejs] = await lens.getProposedNodes();
    expect(ids).to.deep.equal([PILLAR]);            // the bundled FT is not a pending proposal
    expect(kinds.map(Number)).to.deep.equal([NodeKind.Pillar]);
    expect(parents[0]).to.equal(ZERO_HASH);
    expect(metas[0]).to.equal(META_P);
    expect(proposers[0]).to.equal(signers[0].address);
    expect(ends.map(Number)).to.deep.equal([1]);
    expect(rejs.map(Number)).to.deep.equal([0]);    // no dissent yet

    // A reject vote is reflected in the Lens rejection count (queue-gate source).
    await rejectNodeSigned(contract, signers[1], PILLAR);
    const [, , , , , , rejs2] = await lens.getProposedNodes();
    expect(rejs2.map(Number)).to.deep.equal([1]);

    await endorseNodeSigned(contract, signers[2], PILLAR);
    await endorseNodeSigned(contract, signers[3], PILLAR); // → 3 endorsements → ratifies & clears
    const after = await lens.getProposedNodes();
    expect(after[0].length).to.equal(0);
  });

  it("getPillars / getTopics return ratified nodes with meta hashes", async () => {
    const { contract } = await deploy(0, 1, false);
    await propPillar(contract);
    await propTopic(contract);
    const [pIds, pMetas] = await contract.getPillars();
    expect(pIds).to.deep.equal([PILLAR]);
    expect(pMetas).to.deep.equal([META_P]);
    const [tIds, tMetas] = await contract.getTopics(PILLAR);
    expect(tIds).to.deep.equal([FT, TOPIC]);
    expect(tMetas).to.deep.equal([META_FT, META_T]);
  });

  it("taxonomy actions are blocked when paused", async () => {
    const { contract } = await deploy(0, 1, false);
    await contract.pause();
    await expect(propPillar(contract)).to.be.revertedWith("paused");
  });

  // ── Reject path: a proposal is no longer doomed to merely time out — once
  // peers reject it past the point where ratification is still reachable, it is
  // settled as terminal Rejected, mirroring the binding review's early expulsion.
  it("rejectNode flips a proposal to Rejected once ratification is impossible, and burns the id", async () => {
    const { contract, signers } = await deploy(0, 4, false); // bundleThreshold(2)@4 = 3
    await propPillar(contract);                               // proposer signers[0] = endorsement #1
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Proposed);
    expect(await contract.topicReserved(FT)).to.equal(true);
    expect(await contract.evidenceReserved(EV_FP)).to.equal(true);

    // One reject still leaves ratification reachable (max endorsements 3 == gate).
    await expect(rejectNodeSigned(contract, signers[1], PILLAR))
      .to.emit(contract, "NodeRejectVoteCast").withArgs(PILLAR, signers[1].address, 1n, 3n)
      .and.to.not.emit(contract, "NodeRejected");
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Proposed);

    // The second reject makes ratification arithmetically impossible → Rejected.
    await expect(rejectNodeSigned(contract, signers[2], PILLAR))
      .to.emit(contract, "NodeRejected").withArgs(PILLAR, 2n);
    const node = await contract.getTaxonomyNode(PILLAR);
    expect(node.state).to.equal(NodeState.Rejected);
    expect(node.rejections).to.equal(2n);

    // Reservations freed; the bundled topic/evidence never materialized.
    expect(await contract.topicReserved(FT)).to.equal(false);
    expect(await contract.evidenceReserved(EV_FP)).to.equal(false);
    expect((await contract.getTaxonomyNode(FT)).state).to.equal(NodeState.None);
    expect((await contract.getEvidence(EV_FP)).exists).to.equal(false);
    expect(await contract.pillarIds()).to.deep.equal([]);

    // Terminal: a Rejected id can't be re-proposed, endorsed, rejected, or lapsed.
    await expect(propPillar(contract)).to.be.revertedWith("node exists");
    await expect(endorseNodeSigned(contract, signers[1], PILLAR)).to.be.revertedWith("not proposed");
    await expect(rejectNodeSigned(contract, signers[3], PILLAR)).to.be.revertedWith("not proposed");
  });

  it("a peer casts one taxonomy act per round — endorse and reject are mutually exclusive", async () => {
    const { contract, signers } = await deploy(0, 4, false);
    await propPillar(contract);
    // The proposer already endorsed as #1, so it cannot also reject.
    await expect(rejectNodeSigned(contract, contract.runner, PILLAR)).to.be.revertedWith("already voted");
    // A peer that endorses cannot then reject…
    await endorseNodeSigned(contract, signers[1], PILLAR);
    await expect(rejectNodeSigned(contract, signers[1], PILLAR)).to.be.revertedWith("already voted");
    // …and a peer that rejects cannot then endorse.
    await rejectNodeSigned(contract, signers[2], PILLAR);
    await expect(endorseNodeSigned(contract, signers[2], PILLAR)).to.be.revertedWith("already endorsed");
  });

  it("rejectNode requires a live proposal and an active peer", async () => {
    const { contract, signers } = await deploy(0, 4, false);
    await expect(rejectNodeSigned(contract, signers[0], PILLAR)).to.be.revertedWith("not proposed");
    await propPillar(contract);
    await expect(rejectNodeSigned(contract, signers[5], PILLAR)).to.be.revertedWith("not an active peer");
  });

  it("a minority reject does not block ratification", async () => {
    const { contract, signers } = await deploy(0, 5, false); // bundleThreshold(2)@5 = 3
    await propPillar(contract);                              // signers[0] endorses (#1)
    await rejectNodeSigned(contract, signers[1], PILLAR);    // 1 reject — not enough to block
    await endorseNodeSigned(contract, signers[2], PILLAR);   // → 2 endorsements
    await expect(endorseNodeSigned(contract, signers[3], PILLAR)) // → 3 → ratifies past the dissent
      .to.emit(contract, "PillarRatified").withArgs(PILLAR, META_P);
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Ratified);
  });

  it("rejects a topic proposal once ratification is impossible (parent pillar untouched)", async () => {
    const { contract, signers } = await deploy(0, 5, false); // bundleThreshold(2)@5 = 3
    // Ratify the parent pillar first (3 endorsements).
    await propPillar(contract);
    await endorseNodeSigned(contract, signers[1], PILLAR);
    await endorseNodeSigned(contract, signers[2], PILLAR);
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Ratified);

    // Propose a topic under it, then reject to impossibility (needs 3 rejects).
    await propTopic(contract); // signers[0] endorses #1
    await rejectNodeSigned(contract, signers[1], TOPIC);
    await rejectNodeSigned(contract, signers[2], TOPIC);
    await expect(rejectNodeSigned(contract, signers[3], TOPIC))
      .to.emit(contract, "NodeRejected").withArgs(TOPIC, 3n);
    expect((await contract.getTaxonomyNode(TOPIC)).state).to.equal(NodeState.Rejected);
    expect(await contract.evidenceReserved(EV_T)).to.equal(false);
    expect((await contract.getEvidence(EV_T)).exists).to.equal(false);
    // The parent pillar and its founding topic are unaffected.
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Ratified);
    expect(await contract.topicIds(PILLAR)).to.deep.equal([FT]);
  });

  it("a timed-out proposal with non-blocking rejections Lapses (re-filable), not Rejected", async () => {
    const { contract, signers } = await deploy(0, 5, false); // bundle 3 — impossible needs 3 rejects
    await propPillar(contract);
    await rejectNodeSigned(contract, signers[1], PILLAR);    // 1 reject — ratification still reachable
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Proposed);

    await time.increase(PROPOSAL_WINDOW + 1);
    await expect(contract.lapseProposal(PILLAR))
      .to.emit(contract, "ProposalLapsed").withArgs(PILLAR)
      .and.to.not.emit(contract, "NodeRejected");
    // A Lapse fully GCs the node (back to None) — the id is NOT terminally burned.
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.None);
    await expect(propPillar(contract)).to.not.be.reverted; // re-filable
  });
});

describe("EvidenceConsensus — founding bundle invariants", () => {
  const PILLAR  = nodeId("founding-pillar");
  const FT      = nodeId("founding-topic");
  const META_P  = contentHash("founding-pillar-meta");
  const META_FT = contentHash("founding-topic-meta");
  const CH      = contentHash("founding-payload");

  it("rejects a pillar whose id collides with its founding topic id", async () => {
    const { contract } = await deploy(0, 1, false);
    await expect(proposePillarSigned(contract, contract.runner,PILLAR, META_P, PILLAR, META_FT, evidenceId(1), 2, CH))
      .to.be.revertedWith("id collision");
  });

  it("rejects bundled founding evidence that already exists", async () => {
    const { contract } = await deploy(); // seeded: FOUNDING_EV_1 already exists
    await expect(
      proposePillarSigned(contract, contract.runner,PILLAR, META_P, FT, META_FT, FOUNDING_EV_1, 2, CH),
    ).to.be.revertedWith("evidence taken");
  });

  it("validates the founding evidence (zero id / tier / content hash)", async () => {
    const { contract } = await deploy(0, 1, false);
    await expect(proposePillarSigned(contract, contract.runner,PILLAR, META_P, FT, META_FT, ZERO_HASH, 2, CH))
      .to.be.revertedWith("zero evidence id");
    await expect(proposePillarSigned(contract, contract.runner,PILLAR, META_P, FT, META_FT, evidenceId(1), 0, CH))
      .to.be.revertedWith("invalid tier");
    await expect(proposePillarSigned(contract, contract.runner,PILLAR, META_P, FT, META_FT, evidenceId(1), 2, ZERO_HASH))
      .to.be.revertedWith("empty content hash");
  });

  it("reserves the bundled topic id against a competing claim until the pillar ratifies", async () => {
    const { contract, signers } = await deploy(0, 4, false); // threshold 3 → pillar stays pending
    await proposePillarSigned(contract, contract.runner,PILLAR, META_P, FT, META_FT, evidenceId(1), 2, CH);
    expect(await contract.topicReserved(FT)).to.equal(true);

    // A second pillar can't bundle the reserved topic.
    await expect(
      proposePillarSigned(contract, contract.runner,nodeId("rival"), META_P, FT, META_FT, evidenceId(2), 2, CH),
    ).to.be.revertedWith("topic taken");

    // Reservation clears once the pillar ratifies and the topic materializes.
    await endorseNodeSigned(contract, signers[1], PILLAR);
    await endorseNodeSigned(contract, signers[2], PILLAR); // → 3 → ratifies
    expect(await contract.topicReserved(FT)).to.equal(false);
    expect((await contract.getTaxonomyNode(FT)).state).to.equal(NodeState.Ratified);
  });

  it("reserves the founding evidence id so a concurrent submit or bundle can't race it (H1)", async () => {
    const { contract, signers } = await deploy(0, 4, false); // threshold 3 → pillar stays pending
    const E = evidenceId(1);
    await proposePillarSigned(contract, contract.runner,PILLAR, META_P, FT, META_FT, E, 2, CH);
    expect(await contract.evidenceReserved(E)).to.equal(true);

    // Cannot submitEvidence the reserved id directly.
    await expect(contract.submitEvidence(E, 2, DEFAULT_TOPIC, contentHash("race")))
      .to.be.revertedWith("evidence reserved");
    // A second bundle cannot reuse the reserved evidence id either.
    await expect(
      proposePillarSigned(contract, contract.runner,nodeId("rival2"), META_P, nodeId("ft2"), META_FT, E, 2, CH),
    ).to.be.revertedWith("evidence taken");

    // Once the pillar ratifies, the reservation is consumed (record exists, no overwrite).
    await endorseNodeSigned(contract, signers[1], PILLAR);
    await endorseNodeSigned(contract, signers[2], PILLAR); // → 3 → ratifies
    expect(await contract.evidenceReserved(E)).to.equal(false);
    expect((await contract.getEvidence(E)).exists).to.equal(true);
    expect((await contract.getEvidence(E)).contentHash).to.equal(CH);
  });

  it("lapseProposal garbage-collects a stalled proposal and frees its ids (M3)", async () => {
    const { contract, signers } = await deploy(0, 4, false); // threshold 3 → stays pending
    const E = evidenceId(1);
    await proposePillarSigned(contract, contract.runner,PILLAR, META_P, FT, META_FT, E, 2, CH);

    await expect(contract.lapseProposal(PILLAR)).to.be.revertedWith("window still open");
    await time.increase(PROPOSAL_WINDOW + 1);
    await expect(contract.lapseProposal(PILLAR))
      .to.emit(contract, "ProposalLapsed").withArgs(PILLAR);

    // Node, reservations, and bundle are all cleared.
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.None);
    expect(await contract.topicReserved(FT)).to.equal(false);
    expect(await contract.evidenceReserved(E)).to.equal(false);

    // The id can be proposed again, and a prior endorser may endorse the new round.
    await proposePillarSigned(contract, contract.runner,PILLAR, META_P, FT, META_FT, E, 2, CH); // proposer signer0 → #1
    expect(await contract.hasEndorsedNode(PILLAR, signers[1].address)).to.equal(false);
    await endorseNodeSigned(contract, signers[1], PILLAR);              // → 2
    await endorseNodeSigned(contract, signers[2], PILLAR);              // → 3 → ratifies
    expect((await contract.getTaxonomyNode(PILLAR)).state).to.equal(NodeState.Ratified);
  });

  it("a ratified topic accepts further evidence through the normal review flow", async () => {
    const { contract, signers } = await deploy(); // DEFAULT_TOPIC is ratified with its founding evidence
    const id = evidenceId(123);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("more"));
    expect(await bindingState(contract, id, DEFAULT_TOPIC)).to.equal(State.Submitted);
    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true); // threshold 1 → canon
    expect(await bindingState(contract, id, DEFAULT_TOPIC)).to.equal(State.Canon);
  });
});

describe("EvidenceConsensus — review determinism (H1)", () => {
  it("a sub-canonize reject minority cannot pre-empt a canonizing majority", async () => {
    // n=10 tier-1: canonize = 6 (majority), early-expel only when reject > 10-6 = 4
    // (i.e. ≥5).  Four early rejects (40%) must NOT expel, and it still canonizes at 6.
    const { contract, signers } = await deploy(0, 10);
    const id = evidenceId(1);
    await contract.submitEvidence(id, 1, DEFAULT_TOPIC, contentHash("x"));
    for (let i = 0; i < 4; i++) await reviewVote(contract, signers[i], id, DEFAULT_TOPIC, false);
    expect(await bindingState(contract, id)).to.equal(State.Submitted); // not expelled
    for (let i = 4; i < 10; i++) await reviewVote(contract, signers[i], id, DEFAULT_TOPIC, true); // 6 approves
    expect(await bindingState(contract, id)).to.equal(State.Canon);     // majority wins
  });

  it("early expel fires only once canonization is arithmetically impossible", async () => {
    // n=10 tier-1: canonize = 6, so canon dies when reject > 10-6 = 4 (the 5th reject).
    const { contract, signers } = await deploy(0, 10);
    const id = evidenceId(1);
    await contract.submitEvidence(id, 1, DEFAULT_TOPIC, contentHash("x"));
    for (let i = 0; i < 4; i++) await reviewVote(contract, signers[i], id, DEFAULT_TOPIC, false);
    expect(await bindingState(contract, id)).to.equal(State.Submitted); // 4 rejects: canon still possible
    await reviewVote(contract, signers[4], id, DEFAULT_TOPIC, false); // 5th → canon impossible
    expect(await bindingState(contract, id)).to.equal(State.Expelled);
  });

  it("at window close, an expel-quorum of rejections expels; mere apathy lapses", async () => {
    const { contract, signers } = await deploy(0, 10); // expelThreshold = ceil(10*0.25) = 3
    const expelId = evidenceId(1);
    const lapseId = evidenceId(2);
    await contract.submitEvidence(expelId, 1, DEFAULT_TOPIC, contentHash("e"));
    await contract.submitEvidence(lapseId, 1, DEFAULT_TOPIC, contentHash("l"));
    for (let i = 0; i < 3; i++) await reviewVote(contract, signers[i], expelId, DEFAULT_TOPIC, false); // 3 rejects, canon not impossible
    await reviewVote(contract, signers[0], lapseId, DEFAULT_TOPIC, false);                            // 1 reject only
    expect(await bindingState(contract, expelId)).to.equal(State.Submitted);

    await time.increase(PENDING_WINDOW + 1);
    await expect(contract.markLapsed(expelId, DEFAULT_TOPIC)).to.emit(contract, "BindingExpelled");
    await expect(contract.markLapsed(lapseId, DEFAULT_TOPIC)).to.emit(contract, "BindingLapsed");
    expect(await bindingState(contract, expelId)).to.equal(State.Expelled);
    expect(await bindingState(contract, lapseId)).to.equal(State.Lapsed);
  });
});

describe("EvidenceConsensus — lapsed re-file (L1)", () => {
  it("a lapsed binding can be re-filed for a fresh review round; expelled cannot", async () => {
    const { contract, signers } = await deploy(0, 5); // canonize(2)=3, expelThreshold=2
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, DEFAULT_TOPIC, contentHash("x"));
    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC, false); // 1 reject: < expel, canon still possible
    await time.increase(PENDING_WINDOW + 1);
    await contract.markLapsed(id, DEFAULT_TOPIC);
    expect(await bindingState(contract, id)).to.equal(State.Lapsed);

    // Re-file: fresh Submitted binding, review round bumped, prior voter may vote again.
    await expect(contract.fileBinding(id, DEFAULT_TOPIC)).to.emit(contract, "BindingSubmitted");
    expect(await bindingState(contract, id)).to.equal(State.Submitted);
    expect((await contract.getEvidence(id)).bindingCount).to.equal(1n); // not double-counted
    expect(await contract.hasVoted(bindingId(id, DEFAULT_TOPIC), 0, signers[0].address)).to.equal(false);
    await reviewVote(contract, signers[0], id, DEFAULT_TOPIC, true);
    const b = await contract.getBinding(id, DEFAULT_TOPIC);
    expect(b.reviewRound).to.equal(2n);
    expect(b.approveCount).to.equal(1n);

    // An expelled binding stays terminal.
    const id2 = evidenceId(2);
    await contract.submitEvidence(id2, 2, DEFAULT_TOPIC, contentHash("y"));
    for (let i = 0; i < 3; i++) await reviewVote(contract, signers[i], id2, DEFAULT_TOPIC, false); // canonize 3 + 3 > 5 → expel at 3rd
    expect(await bindingState(contract, id2)).to.equal(State.Expelled);
    await expect(contract.fileBinding(id2, DEFAULT_TOPIC)).to.be.revertedWith("binding active");
  });
});

describe("EvidenceConsensus — nominee expiry (L2)", () => {
  it("lapseNominee clears a stalled nominee; re-nomination starts a fresh round", async () => {
    const { gov, signers } = await deploy(0, 6, false); // n=6 → nomineeThreshold 3
    const target = signers[6];
    await nominateSigned(gov, signers[0], target.address, "T");
    await endorseNomineeSigned(gov, signers[0], target.address); // signer0 → 1 (< 3)

    await expect(gov.lapseNominee(target.address)).to.be.revertedWith("window still open");
    await time.increase(PROPOSAL_WINDOW + 1);
    await expect(gov.lapseNominee(target.address)).to.emit(gov, "NomineeLapsed").withArgs(target.address);
    expect(await gov.isNominated(target.address)).to.equal(false);
    expect(await gov.nomineeEndorsements(target.address)).to.equal(0);

    // Re-nominate fresh: the prior endorser is no longer locked.
    await nominateSigned(gov, signers[1], target.address, "T2");
    expect(await gov.hasEndorsed(target.address, signers[0].address)).to.equal(false);
    await endorseNomineeSigned(gov, signers[0], target.address); // signer0 endorses round 2 → 1
    expect(await gov.nomineeEndorsements(target.address)).to.equal(1);
  });
});

describe("EvidenceConsensus — taxonomy retirement (M1)", () => {
  const P   = nodeId("retire-pillar");
  const T1  = nodeId("retire-founding-topic");
  const T2  = nodeId("retire-topic-2");
  const mP  = contentHash("retire-pillar-meta");
  const mT1 = contentHash("retire-ft-meta");
  const mT2 = contentHash("retire-t2-meta");
  const CH  = contentHash("retire-payload");

  async function withTwoTopics(seedPhaseK = 0, n = 3) {
    const { contract, signers } = await deploy(seedPhaseK, n, false);
    await ratify(contract, signers,
      () => proposePillarSigned(contract, contract.runner,P, mP, T1, mT1, evidenceId(81001), 2, CH), P);
    await ratify(contract, signers,
      () => proposeTopicSigned(contract, contract.runner,T2, P, mT2, evidenceId(81002), 2, CH), T2);
    return { contract, signers };
  }

  it("retires a ratified topic by supermajority and drops it from the pillar list", async () => {
    const { contract, signers } = await withTwoTopics(); // n=3 → retireThreshold ceil(6/3)=2
    expect(await contract.topicIds(P)).to.deep.equal([T1, T2]);

    await motionRetireSigned(contract, contract.runner, T2);                                   // signer0 → 1
    await expect(voteRetireSigned(contract, signers[1], T2))          // → 2 = threshold
      .to.emit(contract, "NodeRetired").withArgs(T2, NodeKind.Topic, P);
    expect((await contract.getTaxonomyNode(T2)).state).to.equal(NodeState.Retired);
    expect(await contract.topicIds(P)).to.deep.equal([T1]);
    // The pillar still has T1, so it stays ratified.
    expect((await contract.getTaxonomyNode(P)).state).to.equal(NodeState.Ratified);
    expect(await contract.pillarIds()).to.deep.equal([P]);

    // A retired topic accepts no new bindings.
    await expect(contract.submitEvidence(evidenceId(5), 2, T2, contentHash("z")))
      .to.be.revertedWith("unratified topic");
  });

  it("retiring the last topic auto-retires its pillar; pillars can't be retired directly", async () => {
    const { contract, signers } = await withTwoTopics();
    // Pillars are not retired directly — they retire with their last topic.
    await expect(motionRetireSigned(contract, contract.runner, P)).to.be.revertedWith("pillars auto-retire");

    // Retire T2 — the pillar still holds T1, so it stays ratified.
    await motionRetireSigned(contract, contract.runner, T2);
    await voteRetireSigned(contract, signers[1], T2);
    expect((await contract.getTaxonomyNode(P)).state).to.equal(NodeState.Ratified);
    expect(await contract.topicIds(P)).to.deep.equal([T1]);

    // Retire T1 — the LAST topic — auto-retires the pillar in the same tx.
    await motionRetireSigned(contract, contract.runner, T1);
    const txp = voteRetireSigned(contract, signers[1], T1);
    await expect(txp).to.emit(contract, "NodeRetired").withArgs(T1, NodeKind.Topic, P);
    await expect(txp).to.emit(contract, "NodeRetired").withArgs(P, NodeKind.Pillar, ZERO_HASH);
    expect((await contract.getTaxonomyNode(T1)).state).to.equal(NodeState.Retired);
    expect((await contract.getTaxonomyNode(P)).state).to.equal(NodeState.Retired);
    expect(await contract.pillarIds()).to.deep.equal([]);
    expect(await contract.topicIds(P)).to.deep.equal([]);
  });

  it("rejects retiring a non-ratified node and double-motions", async () => {
    const { contract, signers } = await withTwoTopics(0, 5); // n=5 → threshold ceil(10/3)=4, stays open
    await expect(motionRetireSigned(contract, contract.runner, nodeId("ghost"))).to.be.revertedWith("not ratified");
    await motionRetireSigned(contract, contract.runner, T2);
    await expect(motionRetireSigned(contract, signers[1], T2)).to.be.revertedWith("retire already active");
    await expect(motionRetireSigned(contract, contract.runner, T2)).to.be.revertedWith("retire already active");
  });

  it("cancelStaleRetire clears a motion that never reached supermajority", async () => {
    const { contract, signers } = await withTwoTopics(0, 5); // threshold 4 → 1 vote stays open
    await motionRetireSigned(contract, contract.runner, T2);
    await expect(contract.cancelStaleRetire(T2)).to.be.revertedWith("window still open");
    await time.increase(PROPOSAL_WINDOW + 1);
    await expect(contract.cancelStaleRetire(T2)).to.emit(contract, "NodeRetireCancelled").withArgs(T2);
    expect(await contract.retireActive(T2)).to.equal(false);
    expect((await contract.getTaxonomyNode(T2)).state).to.equal(NodeState.Ratified);
    void signers;
  });

  it("retirement is blocked while paused", async () => {
    const { contract } = await withTwoTopics();
    await contract.pause();
    await expect(motionRetireSigned(contract, contract.runner, T2)).to.be.revertedWith("paused");
  });
});

describe("EvidenceConsensus — governance vote-by-signature (taxonomy / retire / force-renounce / nominate)", () => {
  const PILLAR = nodeId("bysig-pillar");
  const FT     = nodeId("bysig-ft");
  const META   = contentHash("bysig-meta");
  const CH     = contentHash("bysig-ch");

  it("endorseNode rejects a Vote signed by another peer", async () => {
    const { contract, signers } = await deploy(0, 4, false);
    await proposePillarSigned(contract, signers[0], PILLAR, META, FT, META, evidenceId(95001), 2, CH);
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const round   = await contract.nodeRound(PILLAR);
    // signers[1] submits but the Vote was signed by signers[2] → mismatch.
    const badSig  = await signVote(signers[2], await contract.getAddress(), chainId, PILLAR, VP_TAXONOMY, true, round, ZERO_HASH);
    await expect(contract.connect(signers[1]).endorseNode(PILLAR, ZERO_HASH, badSig))
      .to.be.revertedWith("bad sig");
  });

  it("endorseNode binds the deliberation note (tampered noteHash rejected)", async () => {
    const { contract, signers } = await deploy(0, 4, false);
    await proposePillarSigned(contract, signers[0], PILLAR, META, FT, META, evidenceId(95002), 2, CH);
    const chainId  = Number((await ethers.provider.getNetwork()).chainId);
    const round    = await contract.nodeRound(PILLAR);
    const signed   = ethers.keccak256(ethers.toUtf8Bytes("genuine grounds"));
    const tampered = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
    const sig = await signVote(signers[1], await contract.getAddress(), chainId, PILLAR, VP_TAXONOMY, true, round, signed);
    await expect(contract.connect(signers[1]).endorseNode(PILLAR, tampered, sig)).to.be.revertedWith("bad sig");
    await expect(contract.connect(signers[1]).endorseNode(PILLAR, signed, sig)).to.emit(contract, "NodeEndorsed");
  });

  it("proposePillar binds the round (a stale-round signature is rejected)", async () => {
    const { contract, signers } = await deploy(0, 2, false);
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    // A propose mints round+1; signing the CURRENT round is stale.
    const staleSig = await signVote(signers[0], await contract.getAddress(), chainId, PILLAR, VP_TAXONOMY, true, await contract.nodeRound(PILLAR), ZERO_HASH);
    await expect(contract.proposePillar(PILLAR, META, FT, META, evidenceId(95003), 2, CH, ZERO_HASH, staleSig))
      .to.be.revertedWith("bad sig");
  });

  it("retire motion rejects a Vote from another peer, accepts a valid one", async () => {
    const { contract, signers } = await deploy(0, 5, true); // seeds DEFAULT_TOPIC_2
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const round   = (await contract.retireRound(DEFAULT_TOPIC_2)) + 1n;
    const badSig  = await signVote(signers[2], await contract.getAddress(), chainId, DEFAULT_TOPIC_2, VP_RETIRE, true, round, ZERO_HASH);
    await expect(contract.connect(signers[1]).motionRetireNode(DEFAULT_TOPIC_2, ZERO_HASH, badSig))
      .to.be.revertedWith("bad sig");
    await expect(motionRetireSigned(contract, signers[1], DEFAULT_TOPIC_2)).to.emit(contract, "NodeRetireMotioned");
  });

  it("force-renounce motion rejects a Vote from another peer, accepts a valid one", async () => {
    const { contract, signers } = await deploy(0, 3, false); // owner = signers[0]
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const round   = (await contract.forceRenounceRound()) + 1n;
    const badSig  = await signVote(signers[2], await contract.getAddress(), chainId, FORCE_RENOUNCE_ID, VP_FORCE, true, round, ZERO_HASH);
    await expect(contract.connect(signers[1]).motionForceRenounce(ZERO_HASH, badSig))
      .to.be.revertedWith("bad sig");
    await expect(motionForceRenounceSigned(contract, signers[1])).to.emit(contract, "ForceRenounceMotioned");
  });

  it("nominate rejects a PeerVote from another peer, accepts the nominator's own", async () => {
    const { gov, signers } = await deploy(0, 2, false); // nominations open
    const target  = signers[3];
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const round   = (await gov.nomineeRound(target.address)) + 1n;
    const badSig  = await signPeerVote(signers[1], await gov.getAddress(), chainId, target.address, VK_NOMINATE, true, round, ZERO_HASH);
    await expect(gov.connect(signers[0]).nominatePeer(target.address, "T", ZERO_HASH, badSig))
      .to.be.revertedWith("bad sig");
    await expect(nominateSigned(gov, signers[0], target.address, "T")).to.emit(gov, "PeerNominated");
  });
});

// Matcher helper for the uint48 timestamp in BindingCanonized.
function anyUint() {
  const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
  return anyValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit fixes: electorate snapshots (H1) + liveness on every peer act (H2).
// These exercise the scenarios the audit flagged as previously untested —
// a vote tally judged against a CHANGED peer set.
// ─────────────────────────────────────────────────────────────────────────────
describe("AUDIT FIX — frozen electorate snapshots (H1) + governance liveness (H2)", () => {
  const INACT = 30 * DAY;

  it("H1: a taxonomy proposal's ratify gate is FROZEN at propose-time (peer-set growth can't raise it)", async () => {
    // n=4 → bundle gate = max(taxonomy 3, canonize(1) 3) = 3. Grow to 12 (live
    // gate would be max(7, 8) = 8). Reaching 3 endorsements must still ratify,
    // proving the gate is judged against the frozen snapshot, not the live count.
    const { contract, genesis } = await deploy(OPEN_SEED, 4, false);
    const P = nodeId("frozen-grow"), FT = nodeId("frozen-grow-ft");
    await proposePillarSigned(contract, genesis[0], P, contentHash("m"), FT, contentHash("mft"), evidenceId(80101), 1, contentHash("c"));
    await padPeers(contract, 12);
    expect(await contract.activePeerCount()).to.equal(12n);

    await endorseNodeSigned(contract, genesis[1], P); // endorsements = 2
    expect((await contract.getTaxonomyNode(P)).state).to.equal(NodeState.Proposed);
    await endorseNodeSigned(contract, genesis[2], P); // endorsements = 3 == frozen gate
    expect((await contract.getTaxonomyNode(P)).state).to.equal(NodeState.Ratified);
  });

  it("H1: terminal reject (burn) is judged against the FROZEN snapshot, not a (grown) live count", async () => {
    // n=4: ratify-impossible ⇔ rejections + gate(3) > snapshot(4) ⇔ rejections ≥ 2.
    // Grow to 20 (live burn bar would need rejections ≥ ~9). Two rejects must
    // still burn the id terminally, against the frozen electorate of 4.
    const { contract, genesis } = await deploy(OPEN_SEED, 4, false);
    const P = nodeId("frozen-burn"), FT = nodeId("frozen-burn-ft");
    await proposePillarSigned(contract, genesis[0], P, contentHash("m"), FT, contentHash("mft"), evidenceId(80201), 1, contentHash("c"));
    await padPeers(contract, 20);

    await rejectNodeSigned(contract, genesis[1], P); // rejections = 1
    expect((await contract.getTaxonomyNode(P)).state).to.equal(NodeState.Proposed);
    await rejectNodeSigned(contract, genesis[2], P); // rejections = 2 → burn
    expect((await contract.getTaxonomyNode(P)).state).to.equal(NodeState.Rejected);

    // The burned id is terminal — it cannot be re-proposed.
    await expect(
      proposePillarSigned(contract, genesis[0], P, contentHash("m"), nodeId("ft2"), contentHash("mft"), evidenceId(80202), 1, contentHash("c")),
    ).to.be.revertedWith("node exists");
  });

  it("H1: a retire motion's 2/3 bar is FROZEN at motion-open (growth can't raise it)", async () => {
    // n=4 → retire bar ceil(2·4/3)=3. Grow to 20 (live bar would be ceil(40/3)=14).
    // Three votes must still retire the topic, against the frozen electorate.
    const { contract, genesis } = await deploy(OPEN_SEED, 4, true);
    await motionRetireSigned(contract, genesis[0], DEFAULT_TOPIC_2); // votes = 1, snapshot = 4
    await padPeers(contract, 20);

    await voteRetireSigned(contract, genesis[1], DEFAULT_TOPIC_2);    // votes = 2
    expect((await contract.getTaxonomyNode(DEFAULT_TOPIC_2)).state).to.equal(NodeState.Ratified);
    await voteRetireSigned(contract, genesis[2], DEFAULT_TOPIC_2);    // votes = 3 == frozen bar
    expect((await contract.getTaxonomyNode(DEFAULT_TOPIC_2)).state).to.equal(NodeState.Retired);
  });

  it("H2: taxonomy propose/endorse refresh the caller's liveness clock (no longer prunable)", async () => {
    const { contract, genesis } = await deploy(5, 8, false); // 8 peers > seedPhaseK 5 → prune allowed
    await time.increase(INACT + 1); // every peer's admission clock is now stale

    const P = nodeId("touch-pillar");
    await proposePillarSigned(contract, genesis[1], P, contentHash("m"), nodeId("touch-ft"), contentHash("mft"), evidenceId(80301), 3, contentHash("c"));
    await endorseNodeSigned(contract, genesis[2], P);

    // The proposer and endorser just acted → still active; an idle peer is prunable.
    await expect(contract.pruneInactivePeer(genesis[1].address)).to.be.revertedWith("still active");
    await expect(contract.pruneInactivePeer(genesis[2].address)).to.be.revertedWith("still active");
    await expect(contract.pruneInactivePeer(genesis[3].address)).to.emit(contract, "PeerRemoved");
  });

  it("H2: retire / force-renounce votes refresh the caller's liveness clock", async () => {
    const { contract, genesis } = await deploy(5, 8, true);
    await time.increase(INACT + 1);
    await motionRetireSigned(contract, genesis[1], DEFAULT_TOPIC_2);           // retire act
    await motionForceRenounceSigned(contract, genesis[2]);                     // force-renounce act
    await expect(contract.pruneInactivePeer(genesis[1].address)).to.be.revertedWith("still active");
    await expect(contract.pruneInactivePeer(genesis[2].address)).to.be.revertedWith("still active");
  });

  it("GOV H-1/M-1: nominee admission gate is FROZEN at nomination (a shrink can't lower it)", async () => {
    // Nominate at n=9 (nominationsOpen since seedPhaseK=0): frozen gate floor(9/3)+1 = 4.
    // Shrink the set to 3 via inactivity GC (live gate would fall to 2). A second
    // endorsement reaches the LIVE gate but NOT the frozen gate → still no admission.
    const { contract, gov, genesis, signers } = await deploy(0, 9, false);
    const nominee = signers[10].address;
    await nominateSigned(gov, genesis[0], nominee, "N");      // snapshot 9 → frozen gate 4
    await endorseNomineeSigned(gov, genesis[1], nominee);     // endorsements = 1

    await time.increase(INACT + 1);
    for (let i = 3; i <= 8; i++) await contract.pruneInactivePeer(genesis[i].address); // 9 → 3
    expect(await contract.activePeerCount()).to.equal(3n);
    expect(await gov.nomineeThreshold()).to.equal(2n);        // live gate floor(3/3)+1 = 2

    await endorseNomineeSigned(gov, genesis[2], nominee);     // endorsements = 2 == LIVE gate
    expect(await contract.isActivePeer(nominee)).to.equal(false); // frozen gate (4) still holds
  });

  it("GOV H-1: revocation majority is FROZEN at motion-open (growth can't raise it)", async () => {
    const { contract, gov, genesis } = await deploy(OPEN_SEED, 5, false);
    const target = genesis[4].address;
    await motionRevokeSigned(gov, genesis[0], target);        // snapshot 5 → bar ceil(5/2)=3, votes 1
    await padPeers(contract, 30);
    expect(await gov.revokeThreshold()).to.equal(15n);        // live bar would be (30+1)/2 = 15

    await voteRevokeSigned(gov, genesis[1], target);          // 2
    expect(await contract.isActivePeer(target)).to.equal(true);
    await voteRevokeSigned(gov, genesis[2], target);          // 3 == frozen bar → removed
    expect(await contract.isActivePeer(target)).to.equal(false);
  });

  it("GOV H-2: a stale revocation tally is cleared when an address is re-admitted", async () => {
    const { contract, gov, genesis } = await deploy(2, 6, false); // seedPhaseK 2, 6 peers
    const peer = genesis[5].address;
    await motionRevokeSigned(gov, genesis[0], peer);          // revocationActive, votes = 1 (bar 3)
    expect(await gov.revocationActive(peer)).to.equal(true);

    // Remove the peer by a DIFFERENT path (inactivity GC) — leaves the gov-side
    // revoke tally orphaned, the H-2 vector.
    await time.increase(INACT + 1);
    await contract.pruneInactivePeer(peer);
    expect(await contract.isActivePeer(peer)).to.equal(false);
    expect(await gov.revocationActive(peer)).to.equal(true);  // still lingering pre-readmit

    // Re-admit via the nominee path: admission must wipe the stale tally clean.
    await nominateSigned(gov, genesis[0], peer, "re");
    await endorseNomineeSigned(gov, genesis[1], peer);        // gate floor(5/3)+1 = 2
    await endorseNomineeSigned(gov, genesis[2], peer);
    expect(await contract.isActivePeer(peer)).to.equal(true);
    expect(await gov.revocationActive(peer)).to.equal(false);
    expect(await gov.revokeVoteCount(peer)).to.equal(0n);
  });

  it("M2: the Lens paginates the active-peer set and exposes counts", async () => {
    const { contract, lens } = await deploy(OPEN_SEED, 3, false);
    await padPeers(contract, 9);
    expect(await lens.peerCount()).to.equal(9n);
    const page = await lens.getActivePeersPage(2, 4);
    expect(page.addrs.length).to.equal(4);
    // A window past the end clamps instead of reverting.
    const tail = await lens.getActivePeersPage(7, 100);
    expect(tail.addrs.length).to.equal(2);
  });
});
