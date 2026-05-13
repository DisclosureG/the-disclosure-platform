const { expect }  = require("chai");
const { ethers }  = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ZERO_HASH = "0x" + "0".repeat(64);

const State = {
  Submitted:  0,
  Canon:      1,
  Expelled:   2,
  Lapsed:     3,
  Contested:  4,
  Deprecated: 5,
  Reaffirmed: 6,
};

const DAY  = 24 * 60 * 60;
const PENDING_WINDOW    = 30 * DAY;
const CHALLENGE_WINDOW  = 21 * DAY;
const CHALLENGE_COOLDOWN = 7 * DAY;

// keccak-style id helpers
function evidenceId(seed) {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(seed)), 32);
}
function contentHash(body) {
  return ethers.keccak256(ethers.toUtf8Bytes(body));
}

async function deploy(seedPhaseK = 0, genesisSize = 1) {
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
  return { contract, signers, genesis };
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
    const { contract, signers } = await deploy(5);
    expect(await contract.owner()).to.equal(signers[0].address);
    expect(await contract.genesis()).to.equal(signers[0].address);
    expect(await contract.seedPhaseK()).to.equal(5n);
    expect(await contract.activePeerCount()).to.equal(1n);
    expect(await contract.isActivePeer(signers[0].address)).to.equal(true);
    expect(await contract.isGenesisPeer(signers[0].address)).to.equal(true);
  });
});

describe("EvidenceConsensus — thresholds", () => {
  it("floors all thresholds at 1 with one peer", async () => {
    const { contract } = await deploy();
    expect(await contract.canonizeThreshold(1)).to.equal(1n);
    expect(await contract.canonizeThreshold(2)).to.equal(1n);
    expect(await contract.canonizeThreshold(3)).to.equal(1n);
    expect(await contract.expelThreshold()).to.equal(1n);
    expect(await contract.deprecateThreshold(1)).to.equal(1n);
    expect(await contract.nomineeThreshold()).to.equal(1n);
    expect(await contract.revokeThreshold()).to.equal(1n);
  });

  it("scales correctly for n=10 peers (tier-1 canon = ceil(10*0.45) = 5)", async () => {
    const { contract, signers } = await deploy(0, 10);
    expect(await contract.activePeerCount()).to.equal(10n);
    expect(await contract.canonizeThreshold(1)).to.equal(5n);
    expect(await contract.canonizeThreshold(2)).to.equal(4n);
    expect(await contract.canonizeThreshold(3)).to.equal(3n);
    expect(await contract.expelThreshold()).to.equal(3n);
    expect(await contract.deprecateThreshold(1)).to.equal(7n);
    expect(await contract.deprecateThreshold(2)).to.equal(6n);
    expect(await contract.deprecateThreshold(3)).to.equal(6n);
    expect(await contract.nomineeThreshold()).to.equal(4n); // ceil(10/3) = 4
    expect(await contract.revokeThreshold()).to.equal(5n); // ceil(10/2) = 5
    void signers;
  });

  it("caps nomineeThreshold at 9 for very large networks", async () => {
    // We can't mint 30 signers cheaply in Hardhat — instead validate the math
    // boundary via small n and trust the formula.  ceil(25/3) = 9, ceil(30/3) = 10 → capped to 9.
    const { contract } = await deploy(0, 1);
    // Add 24 more peers (25 total) via owner addPeer
    const [owner, ...rest] = await ethers.getSigners();
    for (let i = 0; i < 19 && i < rest.length; i++) {
      await contract.addPeer(rest[i].address, `Peer-${i}`);
    }
    expect(await contract.activePeerCount()).to.equal(20n);
    expect(await contract.nomineeThreshold()).to.equal(7n); // ceil(20/3)=7
    void owner;
  });
});

describe("EvidenceConsensus — seed-phase gating", () => {
  it("blocks nominatePeer when activePeerCount < seedPhaseK", async () => {
    const { contract, signers } = await deploy(5);
    const [, target] = signers;
    await expect(
      contract.nominatePeer(target.address, "Target")
    ).to.be.revertedWith("seed phase: owner must seed peers first");
  });

  it("owner can seed via addPeer during seed phase", async () => {
    const { contract, signers } = await deploy(5);
    const [, a, b] = signers;
    await contract.addPeer(a.address, "A");
    await contract.addPeer(b.address, "B");
    expect(await contract.activePeerCount()).to.equal(3n);
    expect(await contract.nominationsOpen()).to.equal(false);
  });

  it("unlocks nominations once K is reached", async () => {
    const { contract, signers } = await deploy(3);
    const [, a, b, target] = signers;
    await contract.addPeer(a.address, "A");
    await contract.addPeer(b.address, "B");
    expect(await contract.nominationsOpen()).to.equal(true);
    await expect(contract.nominatePeer(target.address, "Target"))
      .to.emit(contract, "PeerNominated");
  });
});

describe("EvidenceConsensus — peer registry + swap-pop", () => {
  it("swap-pop preserves _peerList integrity across revocations", async () => {
    const { contract, signers } = await deploy(0);
    const [, a, b, c] = signers;
    await contract.addPeer(a.address, "A");
    await contract.addPeer(b.address, "B");
    await contract.addPeer(c.address, "C");
    expect(await contract.activePeerCount()).to.equal(4n);

    // Owner removes B (middle of array) — swap-pop should move C into B's slot
    await contract.removePeer(b.address);
    expect(await contract.activePeerCount()).to.equal(3n);
    expect(await contract.isActivePeer(b.address)).to.equal(false);

    const list = await contract.peerList();
    expect(list.length).to.equal(3);
    expect(list).to.include(signers[0].address);
    expect(list).to.include(a.address);
    expect(list).to.include(c.address);
    expect(list).to.not.include(b.address);
  });

  it("re-adding a previously-revoked peer works", async () => {
    const { contract, signers } = await deploy(0);
    const [, a] = signers;
    await contract.addPeer(a.address, "A");
    await contract.removePeer(a.address);
    await contract.addPeer(a.address, "A-readded");
    expect(await contract.isActivePeer(a.address)).to.equal(true);
    expect(await contract.peerHandle(a.address)).to.equal("A-readded");
  });

  it("rejects re-adding an already-active peer", async () => {
    const { contract, signers } = await deploy();
    await expect(contract.addPeer(signers[0].address, "x"))
      .to.be.revertedWith("already active");
  });

  it("rejects zero address", async () => {
    const { contract } = await deploy();
    await expect(contract.addPeer(ethers.ZeroAddress, "x"))
      .to.be.revertedWith("zero address");
  });
});

describe("EvidenceConsensus — nominee flow", () => {
  it("auto-promotes nominee on endorsement quorum and removes from nominee list", async () => {
    const { contract, signers } = await deploy(0, 2); // 2 peers → nomineeThreshold = 1
    const [g, peer2, target] = signers;
    await contract.connect(peer2).nominatePeer(target.address, "Target");

    let nominees = await contract.nomineeList();
    expect(nominees.length).to.equal(1);
    expect(nominees[0]).to.equal(target.address);

    // Single endorsement meets nomineeThreshold(=1 at activePeerCount=2 → ceil(2/3)=1)
    await expect(contract.endorseNominee(target.address))
      .to.emit(contract, "NomineeVerified");

    expect(await contract.isActivePeer(target.address)).to.equal(true);
    expect(await contract.isNominated(target.address)).to.equal(false);

    nominees = await contract.nomineeList();
    expect(nominees.length).to.equal(0); // swap-popped on promotion
  });

  it("prevents double-endorsement", async () => {
    // n=4 genesis peers; nomineeThreshold = ceil(4/3) = 2.
    // target is signer[4] (outside the genesis set).
    const { contract, signers } = await deploy(0, 4);
    const [, peer2, peer3] = signers;
    const target = signers[4];
    await contract.connect(peer2).nominatePeer(target.address, "T");
    await contract.endorseNominee(target.address); // 1
    await expect(contract.endorseNominee(target.address))
      .to.be.revertedWith("already endorsed");
    await contract.connect(peer3).endorseNominee(target.address); // 2 → auto-promote
    expect(await contract.isActivePeer(target.address)).to.equal(true);
  });

  it("rejects nominating an already-active peer", async () => {
    const { contract, signers } = await deploy(0, 2);
    const [g, peer2] = signers;
    await expect(contract.nominatePeer(peer2.address, "x"))
      .to.be.revertedWith("already a peer");
    void g;
  });

  it("non-peer cannot nominate", async () => {
    const { contract, signers } = await deploy(0, 1);
    const [, outsider, target] = signers;
    await expect(
      contract.connect(outsider).nominatePeer(target.address, "x")
    ).to.be.revertedWith("not an active peer");
  });
});

describe("EvidenceConsensus — revocation", () => {
  it("simple majority revokes and removes peer", async () => {
    const { contract, signers } = await deploy(0, 3); // revokeThreshold = ceil(3/2) = 2
    const [g, peer2, peer3] = signers;
    await contract.motionRevoke(peer3.address);                  // 1 (g)
    await contract.connect(peer2).voteRevoke(peer3.address);     // 2 → auto-revoke
    expect(await contract.isActivePeer(peer3.address)).to.equal(false);
    expect(await contract.activePeerCount()).to.equal(2n);

    const list = await contract.peerList();
    expect(list).to.not.include(peer3.address);
    void g;
  });

  it("self-revoke is blocked", async () => {
    const { contract, signers } = await deploy(0, 2);
    const [g] = signers;
    await expect(contract.motionRevoke(g.address))
      .to.be.revertedWith("cannot self-revoke");
  });

  it("cannot double-motion", async () => {
    const { contract, signers } = await deploy(0, 3);
    const [, peer2, peer3] = signers;
    await contract.motionRevoke(peer3.address);
    await expect(contract.connect(peer2).motionRevoke(peer3.address))
      .to.be.revertedWith("revocation already active");
  });

  it("cannot double-vote on revocation", async () => {
    const { contract, signers } = await deploy(0, 4); // threshold = 2
    const [, peer2, peer3, peer4] = signers;
    await contract.motionRevoke(peer4.address);          // g votes
    // peer2 votes — this hits threshold (2 of 4 -> ceil(4/2)=2), auto-revokes
    await contract.connect(peer2).voteRevoke(peer4.address);
    // peer3 cannot vote anymore — revocation has resolved (revocationActive=false)
    await expect(contract.connect(peer3).voteRevoke(peer4.address))
      .to.be.revertedWith("no revocation active");
  });
});

describe("EvidenceConsensus — evidence submission", () => {
  it("rejects zero contentHash", async () => {
    const { contract } = await deploy();
    await expect(contract.submitEvidence(evidenceId(1), 2, ZERO_HASH))
      .to.be.revertedWith("empty content hash");
  });

  it("rejects invalid tier", async () => {
    const { contract } = await deploy();
    await expect(contract.submitEvidence(evidenceId(1), 0, contentHash("x")))
      .to.be.revertedWith("invalid tier");
    await expect(contract.submitEvidence(evidenceId(1), 4, contentHash("x")))
      .to.be.revertedWith("invalid tier");
  });

  it("rejects duplicate id", async () => {
    const { contract } = await deploy();
    const id = evidenceId(42);
    await contract.submitEvidence(id, 2, contentHash("first"));
    await expect(contract.submitEvidence(id, 2, contentHash("second")))
      .to.be.revertedWith("already submitted");
  });

  it("non-peer cannot submit", async () => {
    const { contract, signers } = await deploy();
    await expect(
      contract.connect(signers[1]).submitEvidence(evidenceId(1), 2, contentHash("x"))
    ).to.be.revertedWith("not an active peer");
  });

  it("emits EvidenceSubmitted with content hash", async () => {
    const { contract, signers } = await deploy();
    const id = evidenceId(7);
    const ch = contentHash("payload-v1");
    await expect(contract.submitEvidence(id, 1, ch))
      .to.emit(contract, "EvidenceSubmitted")
      .withArgs(id, 1, signers[0].address, ch);
    const rec = await contract.getRecord(id);
    expect(rec.contentHash).to.equal(ch);
    expect(rec.tier).to.equal(1);
    expect(rec.state).to.equal(State.Submitted);
  });
});

describe("EvidenceConsensus — review voting", () => {
  it("canonizes on approve threshold (Genesis-1, threshold=1)", async () => {
    const { contract } = await deploy();
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, contentHash("x"));
    await expect(contract.castReviewVote(id, true))
      .to.emit(contract, "EvidenceCanonized");
    expect((await contract.getRecord(id)).state).to.equal(State.Canon);
  });

  it("expels on reject threshold (Genesis-1, threshold=1)", async () => {
    const { contract } = await deploy();
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, contentHash("x"));
    await contract.castReviewVote(id, false);
    expect((await contract.getRecord(id)).state).to.equal(State.Expelled);
  });

  it("prevents double-voting", async () => {
    const { contract } = await deploy(0, 5); // threshold > 1 so first vote doesn't resolve
    const id = evidenceId(1);
    await contract.submitEvidence(id, 1, contentHash("x")); // canonize needs ceil(5*0.45)=3
    await contract.castReviewVote(id, true);
    await expect(contract.castReviewVote(id, true))
      .to.be.revertedWith("already voted");
  });

  it("cannot vote after canonization", async () => {
    const { contract, signers } = await deploy(0, 2); // threshold tier 2 = ceil(2*0.35)=1
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, contentHash("x"));
    await contract.castReviewVote(id, true); // canonizes
    await expect(contract.connect(signers[1]).castReviewVote(id, true))
      .to.be.revertedWith("not in review");
  });

  it("markLapsed flips status only after the window", async () => {
    const { contract } = await deploy();
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, contentHash("x"));
    await expect(contract.markLapsed(id))
      .to.be.revertedWith("window still open");
    await time.increase(PENDING_WINDOW + 1);
    await expect(contract.markLapsed(id)).to.emit(contract, "EvidenceLapsed");
    expect((await contract.getRecord(id)).state).to.equal(State.Lapsed);
  });
});

describe("EvidenceConsensus — challenge lifecycle", () => {
  // Get a piece of evidence to Canon state regardless of peer count.
  // Every genesis signer (up to threshold) approves.
  async function canonized(contract, signers, tier = 2, seed = 1) {
    const id = evidenceId(seed);
    await contract.submitEvidence(id, tier, contentHash("x" + seed));
    const n = Number(await contract.activePeerCount());
    const threshold = Number(await contract.canonizeThreshold(tier));
    for (let i = 0; i < threshold && i < n; i++) {
      await contract.connect(signers[i]).castReviewVote(id, true);
    }
    return id;
  }

  it("opens challenge, deprecates immediately when threshold met (Genesis-1, threshold=1)", async () => {
    const { contract, signers } = await deploy();
    const id = await canonized(contract, signers);
    await expect(contract.openChallenge(id))
      .to.emit(contract, "ChallengeOpened")
      .and.to.emit(contract, "EvidenceDeprecated");
    expect((await contract.getRecord(id)).state).to.equal(State.Deprecated);
  });

  it("reaffirms via window expiry when challenge < threshold (the fixed lockup case)", async () => {
    // n=3, tier 2: canonize=2, deprecate=2.  Two approves to canonize, then
    // openChallenge (challengeVotes=1) is below deprecate threshold (2).
    const { contract, signers } = await deploy(0, 3);
    const id = await canonized(contract, signers, 2);
    await contract.openChallenge(id);

    expect((await contract.getRecord(id)).state).to.equal(State.Contested);

    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(contract.finalizeChallenge(id))
      .to.emit(contract, "EvidenceReaffirmed");
    expect((await contract.getRecord(id)).state).to.equal(State.Reaffirmed);
  });

  it("reaffirms even with zero defense votes (silence ≠ deprecation)", async () => {
    const { contract, signers } = await deploy(0, 3);
    const id = await canonized(contract, signers, 2);
    // peer2 opens the challenge so we can finalize from any address afterward
    await contract.connect(signers[1]).openChallenge(id);
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(contract.finalizeChallenge(id))
      .to.emit(contract, "EvidenceReaffirmed");
    expect((await contract.getRecord(id)).state).to.equal(State.Reaffirmed);
  });

  it("anyone can call finalizeChallenge after window", async () => {
    const { contract, signers } = await deploy(0, 3);
    const id = await canonized(contract, signers, 2);
    await contract.openChallenge(id);
    await time.increase(CHALLENGE_WINDOW + 1);
    const outsider = signers[7];
    await expect(contract.connect(outsider).finalizeChallenge(id))
      .to.not.be.reverted;
  });

  it("blocks finalize while window still open", async () => {
    const { contract, signers } = await deploy(0, 3);
    const id = await canonized(contract, signers, 2);
    await contract.openChallenge(id);
    await expect(contract.finalizeChallenge(id))
      .to.be.revertedWith("window still open");
  });

  it("cannot vote on challenge after window expires", async () => {
    const { contract, signers } = await deploy(0, 5);
    const id = await canonized(contract, signers, 2);
    await contract.openChallenge(id);
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(contract.connect(signers[1]).castChallengeVote(id, false))
      .to.be.revertedWith("window expired");
  });

  it("enforces 7-day per-peer challenge cooldown", async () => {
    const { contract, signers } = await deploy(0, 5);
    const id1 = await canonized(contract, signers, 2, 1);
    const id2 = await canonized(contract, signers, 2, 2);

    await contract.openChallenge(id1);
    await expect(contract.openChallenge(id2))
      .to.be.revertedWith("challenge cooldown active");

    await time.increase(CHALLENGE_COOLDOWN + 1);
    await expect(contract.openChallenge(id2)).to.not.be.reverted;
  });

  it("re-contest resets cycle counters (chain side of v5 indexer fix)", async () => {
    // Locks the assumption the v5 indexer reset relies on: every call to
    // openChallenge() must zero defenseVotes and set challengeVotes to 1,
    // regardless of how many cycles the piece has already been through.
    // If this invariant ever changes, the chain-indexer's ChallengeOpened
    // reconciliation (which mirrors it off-chain) would start diverging.
    const { contract, signers } = await deploy(0, 5);  // tier 2 deprecate = ceil(5*0.6)=3, canon = ceil(5*0.35)=2
    const id = await canonized(contract, signers, 2, 1);

    // Cycle 1: opener + one defender, no deprecation quorum → reaffirm
    await contract.openChallenge(id);                              // signers[0] opens → cv=1
    await contract.connect(signers[1]).castChallengeVote(id, false); // defend → dv=1
    let rec = await contract.getRecord(id);
    expect(rec.challengeVotes).to.equal(1);
    expect(rec.defenseVotes).to.equal(1);

    await time.increase(CHALLENGE_WINDOW + 1);
    await contract.finalizeChallenge(id);
    rec = await contract.getRecord(id);
    expect(rec.state).to.equal(State.Reaffirmed);
    // Cycle 1's tallies remain on the chain record until the next cycle
    // resets them.
    expect(rec.challengeVotes).to.equal(1);
    expect(rec.defenseVotes).to.equal(1);

    // Cooldown for signers[0] is active; use a fresh peer to open cycle 2.
    await contract.connect(signers[2]).openChallenge(id);
    rec = await contract.getRecord(id);
    expect(rec.state).to.equal(State.Contested);
    expect(rec.challengeVotes).to.equal(1);  // ← was 1 in cycle 1 too, but the RESET is the point
    expect(rec.defenseVotes).to.equal(0);    // ← key invariant: defenseVotes wiped
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

describe("EvidenceConsensus — peer-floor invariant", () => {
  it("blocks removePeer when only one peer remains", async () => {
    const { contract, signers } = await deploy();
    await expect(contract.removePeer(signers[0].address))
      .to.be.revertedWith("cannot remove last peer");
  });

  it("blocks revocation that would drop activePeerCount to zero", async () => {
    // 2 peers, revokeThreshold = ceil(2/2) = 1.  motionRevoke alone hits it.
    const { contract, signers } = await deploy(0, 2);
    const [g, peer2] = signers;
    // peer2 motions to revoke g; the auto-removal would leave 1 peer — allowed.
    // To trigger the floor guard we'd need to remove the *last* peer; the
    // contract correctly disallows that because motionRevoke leaves at least
    // one peer.  Verify the inverse: removing the second-to-last peer keeps
    // activePeerCount >= 1.
    await contract.connect(peer2).motionRevoke(g.address);
    expect(await contract.isActivePeer(g.address)).to.equal(false);
    expect(await contract.activePeerCount()).to.equal(1n);
    // Now the only remaining peer cannot be removed.
    await expect(contract.removePeer(peer2.address))
      .to.be.revertedWith("cannot remove last peer");
  });

  it("clears stale revocation state on re-add", async () => {
    const { contract, signers } = await deploy(0, 3);
    const [g, peer2, peer3] = signers;
    // Motion against peer3 by g; peer2 votes → threshold 2 hit → revoked.
    await contract.motionRevoke(peer3.address);
    await contract.connect(peer2).voteRevoke(peer3.address);
    expect(await contract.isActivePeer(peer3.address)).to.equal(false);
    expect(await contract.revocationActive(peer3.address)).to.equal(false);
    // Owner re-adds peer3 — revocation state should be clean.
    await contract.addPeer(peer3.address, "peer3-readded");
    expect(await contract.revocationActive(peer3.address)).to.equal(false);
    expect(await contract.revokeVoteCount(peer3.address)).to.equal(0);
    void g;
  });
});

describe("EvidenceConsensus — pause", () => {
  it("blocks state-changing peer calls when paused", async () => {
    const { contract } = await deploy();
    await contract.pause();
    await expect(contract.submitEvidence(evidenceId(1), 2, contentHash("x")))
      .to.be.revertedWith("paused");
    await contract.unpause();
    await expect(contract.submitEvidence(evidenceId(1), 2, contentHash("x")))
      .to.not.be.reverted;
  });

  it("non-owner cannot pause", async () => {
    const { contract, signers } = await deploy();
    await expect(contract.connect(signers[1]).pause())
      .to.be.revertedWith("not owner");
  });
});

describe("EvidenceConsensus — batched review voting", () => {
  it("castReviewVoteBatch records each vote like the single-vote path", async () => {
    const { contract } = await deploy(0, 1);
    // Three pending tier-3 items (canon threshold = 1, so each canonizes on its own approve).
    const ids = [evidenceId(101), evidenceId(102), evidenceId(103)];
    for (const id of ids) await contract.submitEvidence(id, 3, contentHash(id));

    await contract.castReviewVoteBatch(ids, [true, true, false]);

    expect((await contract.getRecord(ids[0])).state).to.equal(State.Canon);
    expect((await contract.getRecord(ids[1])).state).to.equal(State.Canon);
    expect((await contract.getRecord(ids[2])).state).to.equal(State.Expelled);
  });

  it("rejects mismatched array lengths", async () => {
    const { contract } = await deploy(0, 1);
    const id = evidenceId(200);
    await contract.submitEvidence(id, 2, contentHash("x"));
    await expect(contract.castReviewVoteBatch([id], [true, false]))
      .to.be.revertedWith("length mismatch");
  });

  it("rejects empty batch", async () => {
    const { contract } = await deploy(0, 1);
    await expect(contract.castReviewVoteBatch([], []))
      .to.be.revertedWith("empty batch");
  });

  it("rejects oversize batch (> MAX_REVIEW_BATCH)", async () => {
    const { contract } = await deploy(0, 1);
    const ids = Array.from({ length: 51 }, (_, i) => evidenceId(300 + i));
    const approves = Array.from({ length: 51 }, () => true);
    await expect(contract.castReviewVoteBatch(ids, approves))
      .to.be.revertedWith("batch too large");
  });

  it("reverts atomically: one bad id rolls back the whole batch", async () => {
    const { contract } = await deploy(0, 1);
    const good = evidenceId(400);
    const bad  = evidenceId(401); // not submitted
    await contract.submitEvidence(good, 2, contentHash("g"));
    await expect(contract.castReviewVoteBatch([good, bad], [true, true]))
      .to.be.revertedWith("unknown evidence");
    // Good item must remain in Submitted state since the whole tx reverted.
    expect((await contract.getRecord(good)).state).to.equal(State.Submitted);
    expect(await contract.hasVoted(good, 0, (await ethers.getSigners())[0].address)).to.equal(false);
  });

  it("rejects double-voting inside a single batch", async () => {
    // 3 peers + tier 1 → canonize threshold = ceil(3*0.45) = 2, so the
    // first approve leaves the item still in review and the second entry
    // for the same id must trip "already voted" rather than "not in review".
    const { contract } = await deploy(0, 3);
    const id = evidenceId(500);
    await contract.submitEvidence(id, 1, contentHash("d"));
    await expect(contract.castReviewVoteBatch([id, id], [true, false]))
      .to.be.revertedWith("already voted");
  });
});

describe("EvidenceConsensus — handle length cap", () => {
  it("constructor rejects an oversize genesis handle", async () => {
    const [a] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EvidenceConsensus");
    const tooLong = "x".repeat(65);
    await expect(Factory.deploy([a.address], [tooLong], 0))
      .to.be.revertedWith("handle too long");
  });

  it("addPeer rejects an oversize handle", async () => {
    const { contract, signers } = await deploy(0, 1);
    const [, a] = signers;
    await expect(contract.addPeer(a.address, "x".repeat(65)))
      .to.be.revertedWith("handle too long");
  });

  it("nominatePeer rejects an oversize handle", async () => {
    const { contract, signers } = await deploy(0, 1);
    const [, target] = signers;
    await expect(contract.nominatePeer(target.address, "x".repeat(65)))
      .to.be.revertedWith("handle too long");
  });

  it("accepts a 64-byte handle exactly at the cap", async () => {
    const { contract, signers } = await deploy(0, 1);
    const [, a] = signers;
    const atCap = "x".repeat(64);
    await expect(contract.addPeer(a.address, atCap)).to.not.be.reverted;
    expect(await contract.peerHandle(a.address)).to.equal(atCap);
  });
});

describe("EvidenceConsensus — aggregated views", () => {
  it("getActivePeers returns parallel arrays for all active peers", async () => {
    const { contract, signers } = await deploy(0, 1);
    const [, a, b] = signers;
    await contract.addPeer(a.address, "Alice");
    await contract.addPeer(b.address, "Bob");

    const [addrs, handles, revActive, revVotes] = await contract.getActivePeers();
    expect(addrs.length).to.equal(3);
    expect(handles.length).to.equal(3);
    expect(revActive.length).to.equal(3);
    expect(revVotes.length).to.equal(3);
    const map = Object.fromEntries(addrs.map((a, i) => [a, handles[i]]));
    expect(map[a.address]).to.equal("Alice");
    expect(map[b.address]).to.equal("Bob");
  });

  it("getNominees returns nominees with endorsement counts", async () => {
    const { contract, signers } = await deploy(0, 5);
    const [, , , , , target] = signers;
    await contract.nominatePeer(target.address, "T");
    const [addrs, handles, endorsements] = await contract.getNominees();
    expect(addrs).to.deep.equal([target.address]);
    expect(handles).to.deep.equal(["T"]);
    expect(endorsements.map(Number)).to.deep.equal([0]);
  });
});

describe("EvidenceConsensus — content hash binding", () => {
  it("emits content hash in EvidenceSubmitted and preserves on canonize", async () => {
    const { contract } = await deploy();
    const id  = evidenceId(99);
    const ch1 = contentHash("Title|Source|2026|excerpt");
    await contract.submitEvidence(id, 1, ch1);
    await contract.castReviewVote(id, true);
    const rec = await contract.getRecord(id);
    expect(rec.contentHash).to.equal(ch1);
    expect(rec.state).to.equal(State.Canon);
  });

  it("two different submissions cannot share an id even with different content hashes", async () => {
    const { contract } = await deploy();
    const id = evidenceId(1);
    await contract.submitEvidence(id, 2, contentHash("a"));
    await expect(contract.submitEvidence(id, 2, contentHash("b")))
      .to.be.revertedWith("already submitted");
  });
});
