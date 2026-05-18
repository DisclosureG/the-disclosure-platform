const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ZERO_HASH    = "0x" + "0".repeat(64);
const ZERO_ADDRESS = "0x" + "0".repeat(40);

const State = {
  Submitted:  0,
  Aligned:    1,
  Misaligned: 2,
  Lapsed:     3,
  Contested:  4,
  Deprecated: 5,
  Reaffirmed: 6,
};

const DAY               = 24 * 60 * 60;
const PENDING_WINDOW    = 30 * DAY;
const CHALLENGE_WINDOW  = 21 * DAY;
const CHALLENGE_COOLDOWN = 7 * DAY;

function behaviourId(seed) {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(seed)), 32);
}
function h(body) {
  return ethers.keccak256(ethers.toUtf8Bytes(body));
}

// Deploy a real EvidenceConsensus + a BehaviourConsensus that reads from it.
// `peerCount` peers are seeded via owner addPeer so the registry has the
// expected size at the start of each test.
async function deploy(peerCount = 1) {
  const signers = await ethers.getSigners();
  const Ev = await ethers.getContractFactory("EvidenceConsensus");
  const ev = await Ev.deploy(
    [signers[0].address],
    ["Genesis"],
    0,            // seedPhaseK = 0 so addPeer is the only path during tests
  );
  await ev.waitForDeployment();

  for (let i = 1; i < peerCount; i++) {
    await ev.addPeer(signers[i].address, `Peer-${i}`);
  }

  const Bh = await ethers.getContractFactory("BehaviourConsensus");
  const bh = await Bh.deploy(await ev.getAddress());
  await bh.waitForDeployment();

  return { ev, bh, signers };
}

async function submit(bh, signer, id, opts = {}) {
  const tier       = opts.tier       ?? 1;
  const domain     = opts.domain     ?? 1;
  const modelHash  = opts.modelHash  ?? h("model-A");
  const inputHash  = opts.inputHash  ?? h(`input-${id}`);
  const outputHash = opts.outputHash ?? h(`output-${id}`);
  return bh.connect(signer).submitBehaviour(id, tier, domain, modelHash, inputHash, outputHash);
}

describe("BehaviourConsensus — deployment", () => {
  it("rejects zero peer source", async () => {
    const Bh = await ethers.getContractFactory("BehaviourConsensus");
    await expect(Bh.deploy(ZERO_ADDRESS)).to.be.revertedWith("zero peer source");
  });

  it("stores peer source and owner", async () => {
    const { ev, bh, signers } = await deploy(1);
    expect(await bh.peers()).to.equal(await ev.getAddress());
    expect(await bh.owner()).to.equal(signers[0].address);
    expect(await bh.paused()).to.equal(false);
  });
});

describe("BehaviourConsensus — thresholds", () => {
  it("floors all thresholds at 1 with one peer", async () => {
    const { bh } = await deploy(1);
    expect(await bh.canonizeThreshold(1)).to.equal(1n);
    expect(await bh.canonizeThreshold(2)).to.equal(1n);
    expect(await bh.canonizeThreshold(3)).to.equal(1n);
    expect(await bh.expelThreshold()).to.equal(1n);
    expect(await bh.deprecateThreshold(1)).to.equal(1n);
  });

  it("scales correctly for n=10 peers", async () => {
    const { bh } = await deploy(10);
    expect(await bh.canonizeThreshold(1)).to.equal(5n); // ceil(10*0.45)
    expect(await bh.canonizeThreshold(2)).to.equal(4n);
    expect(await bh.canonizeThreshold(3)).to.equal(3n);
    expect(await bh.expelThreshold()).to.equal(3n);
    expect(await bh.deprecateThreshold(1)).to.equal(7n);
    expect(await bh.deprecateThreshold(2)).to.equal(6n);
    expect(await bh.deprecateThreshold(3)).to.equal(6n);
  });
});

describe("BehaviourConsensus — submission validation", () => {
  it("rejects non-peer submissions", async () => {
    const { bh, signers } = await deploy(1);
    const [, outsider] = signers;
    await expect(
      submit(bh, outsider, behaviourId(1))
    ).to.be.revertedWith("not an active peer");
  });

  it("rejects invalid tier", async () => {
    const { bh, signers } = await deploy(1);
    await expect(submit(bh, signers[0], behaviourId(1), { tier: 0 }))
      .to.be.revertedWith("invalid tier");
    await expect(submit(bh, signers[0], behaviourId(2), { tier: 4 }))
      .to.be.revertedWith("invalid tier");
  });

  it("rejects invalid domain", async () => {
    const { bh, signers } = await deploy(1);
    await expect(submit(bh, signers[0], behaviourId(1), { domain: 0 }))
      .to.be.revertedWith("invalid domain");
    await expect(submit(bh, signers[0], behaviourId(2), { domain: 10 }))
      .to.be.revertedWith("invalid domain");
  });

  it("rejects zero hashes", async () => {
    const { bh, signers } = await deploy(1);
    await expect(submit(bh, signers[0], behaviourId(1), { modelHash:  ZERO_HASH }))
      .to.be.revertedWith("empty model hash");
    await expect(submit(bh, signers[0], behaviourId(2), { inputHash:  ZERO_HASH }))
      .to.be.revertedWith("empty input hash");
    await expect(submit(bh, signers[0], behaviourId(3), { outputHash: ZERO_HASH }))
      .to.be.revertedWith("empty output hash");
  });

  it("rejects duplicate id", async () => {
    const { bh, signers } = await deploy(1);
    await submit(bh, signers[0], behaviourId(1));
    await expect(submit(bh, signers[0], behaviourId(1)))
      .to.be.revertedWith("already submitted");
  });

  it("emits BehaviourSubmitted with all seven args", async () => {
    const { bh, signers } = await deploy(1);
    const id = behaviourId(42);
    const m  = h("model-A");
    const i  = h("input-1");
    const o  = h("output-1");
    await expect(
      bh.connect(signers[0]).submitBehaviour(id, 2, 3, m, i, o)
    )
      .to.emit(bh, "BehaviourSubmitted")
      .withArgs(id, 2, 3, signers[0].address, m, i, o);
  });
});

describe("BehaviourConsensus — review voting", () => {
  it("aligns on approve threshold with one peer", async () => {
    const { bh, signers } = await deploy(1);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await expect(bh.connect(signers[0]).castReviewVote(id, true))
      .to.emit(bh, "BehaviourAligned");
    const r = await bh.getRecord(id);
    expect(r.state).to.equal(State.Aligned);
  });

  it("misaligns on reject threshold", async () => {
    const { bh, signers } = await deploy(1);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await expect(bh.connect(signers[0]).castReviewVote(id, false))
      .to.emit(bh, "BehaviourMisaligned");
    const r = await bh.getRecord(id);
    expect(r.state).to.equal(State.Misaligned);
  });

  it("blocks double-vote in review phase", async () => {
    const { bh, signers } = await deploy(3);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await bh.connect(signers[1]).castReviewVote(id, true);
    await expect(bh.connect(signers[1]).castReviewVote(id, true))
      .to.be.revertedWith("already voted");
  });

  it("blocks voting after terminal state", async () => {
    const { bh, signers } = await deploy(1);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await bh.connect(signers[0]).castReviewVote(id, true); // → Aligned
    // Add a peer and try to vote review on an already-aligned record
    await bh.peers(); // sanity touch
    const [, second] = signers;
    // grant via the underlying EvidenceConsensus
    const evAddr = await bh.peers();
    const ev = await ethers.getContractAt("EvidenceConsensus", evAddr);
    await ev.addPeer(second.address, "Peer-1");
    await expect(bh.connect(second).castReviewVote(id, false))
      .to.be.revertedWith("not in review");
  });
});

describe("BehaviourConsensus — batch voting", () => {
  it("rejects empty batch", async () => {
    const { bh, signers } = await deploy(1);
    await expect(bh.connect(signers[0]).castReviewVoteBatch([], []))
      .to.be.revertedWith("empty batch");
  });

  it("rejects length mismatch", async () => {
    const { bh, signers } = await deploy(1);
    await expect(bh.connect(signers[0]).castReviewVoteBatch([behaviourId(1)], [true, false]))
      .to.be.revertedWith("length mismatch");
  });

  it("rejects oversize batch", async () => {
    const { bh, signers } = await deploy(1);
    const ids = []; const approves = [];
    for (let i = 0; i < 51; i++) { ids.push(behaviourId(i + 1)); approves.push(true); }
    await expect(bh.connect(signers[0]).castReviewVoteBatch(ids, approves))
      .to.be.revertedWith("batch too large");
  });

  it("aligns all entries when threshold met", async () => {
    const { bh, signers } = await deploy(1);
    const ids = [behaviourId(1), behaviourId(2), behaviourId(3)];
    for (const id of ids) await submit(bh, signers[0], id);
    await bh.connect(signers[0]).castReviewVoteBatch(ids, [true, true, true]);
    for (const id of ids) {
      expect((await bh.getRecord(id)).state).to.equal(State.Aligned);
    }
  });
});

describe("BehaviourConsensus — lapse window", () => {
  it("rejects markLapsed before window", async () => {
    const { bh, signers } = await deploy(1);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await expect(bh.connect(signers[0]).markLapsed(id))
      .to.be.revertedWith("window still open");
  });

  it("permits markLapsed after window", async () => {
    const { bh, signers } = await deploy(1);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await time.increase(PENDING_WINDOW + 1);
    await expect(bh.connect(signers[0]).markLapsed(id))
      .to.emit(bh, "BehaviourLapsed");
    expect((await bh.getRecord(id)).state).to.equal(State.Lapsed);
  });
});

describe("BehaviourConsensus — challenge flow", () => {
  it("emits ChallengeOpened with grounds string", async () => {
    const { bh, signers } = await deploy(3);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await bh.connect(signers[0]).castReviewVote(id, true);
    await bh.connect(signers[1]).castReviewVote(id, true);
    // Now aligned (3 peers, tier-1 canonize = ceil(3*0.45) = 2)
    expect((await bh.getRecord(id)).state).to.equal(State.Aligned);
    const grounds = "model lied about its training cutoff";
    await expect(bh.connect(signers[2]).openChallenge(id, grounds))
      .to.emit(bh, "ChallengeOpened")
      .withArgs(id, signers[2].address, anyUint48(), grounds);
  });

  it("rejects challenge on non-aligned record", async () => {
    const { bh, signers } = await deploy(1);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await expect(bh.connect(signers[0]).openChallenge(id, "x"))
      .to.be.revertedWith("not aligned");
  });

  it("enforces cooldown between challenges", async () => {
    const { bh, signers } = await deploy(3);
    const id1 = behaviourId(1), id2 = behaviourId(2);
    for (const id of [id1, id2]) {
      await submit(bh, signers[0], id);
      await bh.connect(signers[0]).castReviewVote(id, true);
      await bh.connect(signers[1]).castReviewVote(id, true);
    }
    await bh.connect(signers[2]).openChallenge(id1, "first");
    await expect(bh.connect(signers[2]).openChallenge(id2, "second"))
      .to.be.revertedWith("challenge cooldown active");
    // Cooldown is 7 days, challenge window is 21 days — id1 is still
    // Contested but the per-challenger cooldown has elapsed. id2 is still
    // Aligned and challengeable.
    await time.increase(CHALLENGE_COOLDOWN + 1);
    await expect(bh.connect(signers[2]).openChallenge(id2, "second"))
      .to.emit(bh, "ChallengeOpened");
  });

  it("deprecates immediately when challenge votes reach threshold", async () => {
    const { bh, signers } = await deploy(2);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await bh.connect(signers[0]).castReviewVote(id, true); // aligned (n=2, tier-1 canonize=1)
    // With n=2, tier-1 deprecate = ceil(2*0.65) = 2. The challenger casts 1
    // implicit support vote when opening; the second peer voting in support
    // pushes to threshold.
    await bh.connect(signers[1]).openChallenge(id, "broken");
    expect((await bh.getRecord(id)).state).to.equal(State.Contested);
    await expect(bh.connect(signers[0]).castChallengeVote(id, true))
      .to.emit(bh, "BehaviourDeprecated");
    expect((await bh.getRecord(id)).state).to.equal(State.Deprecated);
  });

  it("reaffirms on window expiry without threshold", async () => {
    const { bh, signers } = await deploy(3);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    await bh.connect(signers[0]).castReviewVote(id, true);
    await bh.connect(signers[1]).castReviewVote(id, true);
    await bh.connect(signers[2]).openChallenge(id, "speculative");
    // n=3, tier-1 deprecate = ceil(3*0.65) = 2. Only the challenger has
    // voted in support (1). Window expires → reaffirmed.
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(bh.connect(signers[2]).finalizeChallenge(id))
      .to.emit(bh, "BehaviourReaffirmed");
    expect((await bh.getRecord(id)).state).to.equal(State.Reaffirmed);
  });
});

describe("BehaviourConsensus — peer-source integration", () => {
  it("revoking a peer in EvidenceConsensus blocks their vote in BehaviourConsensus", async () => {
    const { ev, bh, signers } = await deploy(3);
    const id = behaviourId(1);
    await submit(bh, signers[0], id);
    // Owner removes signers[1] from the registry
    await ev.removePeer(signers[1].address);
    await expect(bh.connect(signers[1]).castReviewVote(id, true))
      .to.be.revertedWith("not an active peer");
  });
});

describe("BehaviourConsensus — pause", () => {
  it("only owner can pause / unpause", async () => {
    const { bh, signers } = await deploy(2);
    await expect(bh.connect(signers[1]).pause()).to.be.revertedWith("not owner");
    await bh.connect(signers[0]).pause();
    expect(await bh.paused()).to.equal(true);
    await bh.connect(signers[0]).unpause();
    expect(await bh.paused()).to.equal(false);
  });

  it("paused state blocks state-changing functions", async () => {
    const { bh, signers } = await deploy(1);
    await bh.connect(signers[0]).pause();
    await expect(submit(bh, signers[0], behaviourId(1)))
      .to.be.revertedWith("paused");
  });
});

describe("BehaviourConsensus — ownership transfer", () => {
  it("two-step transfer succeeds end-to-end", async () => {
    const { bh, signers } = await deploy(1);
    const [from, to] = signers;
    await bh.connect(from).proposeOwner(to.address);
    expect(await bh.pendingOwner()).to.equal(to.address);
    await bh.connect(to).acceptOwnership();
    expect(await bh.owner()).to.equal(to.address);
    expect(await bh.pendingOwner()).to.equal(ZERO_ADDRESS);
  });

  it("cancel aborts pending transfer", async () => {
    const { bh, signers } = await deploy(1);
    const [from, to] = signers;
    await bh.connect(from).proposeOwner(to.address);
    await bh.connect(from).cancelOwnershipTransfer();
    expect(await bh.pendingOwner()).to.equal(ZERO_ADDRESS);
    await expect(bh.connect(to).acceptOwnership())
      .to.be.revertedWith("not pending owner");
  });
});

describe("BehaviourConsensus — tripleHash", () => {
  it("matches off-chain keccak256(abi.encodePacked(m,i,o))", async () => {
    const { bh } = await deploy(1);
    const m = h("model-A"), i = h("input-1"), o = h("output-1");
    const onChain = await bh.tripleHash(m, i, o);
    const offChain = ethers.keccak256(ethers.concat([m, i, o]));
    expect(onChain).to.equal(offChain);
  });
});

// Helper matcher for uint48 timestamps emitted as event args.
function anyUint48() {
  return (value) => typeof value === "bigint" && value > 0n && value < (1n << 48n);
}
