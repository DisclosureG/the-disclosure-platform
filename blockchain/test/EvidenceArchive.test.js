const { expect } = require("chai");
const { ethers } = require("hardhat");

// ── Minimal helpers (duplicated from EvidenceConsensus.test.js, the pattern the
// audit test file also follows — test files aren't importable modules) ──────────
const ZERO_HASH = "0x" + "0".repeat(64);
const NodeState = { None: 0, Proposed: 1, Ratified: 2, Retired: 3, Rejected: 4 };
const VP_TAXONOMY = 2;

function evidenceId(seed) {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(seed)), 32);
}
function hashOf(s) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}
function nodeId(slug) {
  return ethers.keccak256(ethers.toUtf8Bytes(slug));
}

async function signVote(signer, addr, chainId, bindingId, phase, support, round, noteHash) {
  const domain = { name: "EvidenceConsensus", version: "1", chainId, verifyingContract: addr };
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
async function proposePillarSigned(c, signer, id, metaHash, topicId, topicMetaHash, evId, tier, ch, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = (await c.nodeRound(id)) + 1n;
  const sig     = await signVote(signer, await c.getAddress(), chainId, id, VP_TAXONOMY, true, round, noteHash);
  return c.connect(signer).proposePillar(id, metaHash, topicId, topicMetaHash, evId, tier, ch, noteHash, sig);
}
async function endorseNodeSigned(c, signer, id, noteHash = ZERO_HASH) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const round   = await c.nodeRound(id);
  const sig     = await signVote(signer, await c.getAddress(), chainId, id, VP_TAXONOMY, true, round, noteHash);
  return c.connect(signer).endorseNode(id, noteHash, sig);
}
async function ratify(c, peers, proposeCall, id) {
  await proposeCall();
  let i = 1;
  while (Number((await c.getTaxonomyNode(id)).state) !== NodeState.Ratified) {
    await endorseNodeSigned(c, peers[i], id);
    i++;
  }
}

const PILLAR     = nodeId("pillar-archive");
const TOPIC      = nodeId("topic-archive");
const FOUNDING   = evidenceId(90101);
// Real canonical JSON strings, exactly as the off-chain helpers would serialize.
const PILLAR_META  = JSON.stringify({ kind: "pillar", slug: "pillar-archive", parent: "", title: "Disclosure", blurb: "Root pillar", tag: "core" });
const TOPIC_META   = JSON.stringify({ kind: "topic", slug: "topic-archive", parent: "pillar-archive", title: "Sightings", blurb: "A topic", tag: "" });
const FOUNDING_CONTENT = JSON.stringify({ title: "Gimbal", source: "AARO", year: "2022", excerpt: "FLIR1", link: "https://example.org/gimbal", tier: 2 });

async function deployAll() {
  const signers = await ethers.getSigners();
  // Open seed phase so owner addPeer stays available to grow the peer set.
  const genesisSize = 5;
  const genesis = signers.slice(0, genesisSize);
  const handles = genesis.map((_, i) => `Genesis-${i}`);
  const Core = await ethers.getContractFactory("EvidenceConsensus");
  const core = await Core.deploy(genesis.map(s => s.address), handles, 1_000_000);
  await core.waitForDeployment();
  const Gov = await ethers.getContractFactory("PeerGovernance");
  const gov = await Gov.deploy(await core.getAddress());
  await gov.waitForDeployment();
  await core.setGovernance(await gov.getAddress());
  const Archive = await ethers.getContractFactory("EvidenceArchive");
  const archive = await Archive.deploy(await core.getAddress());
  await archive.waitForDeployment();

  // Ratify a pillar bundling a topic + founding evidence so the topic is live
  // and the founding evidence is materialized with FOUNDING_CONTENT's hash.
  await ratify(
    core, genesis,
    () => proposePillarSigned(
      core, genesis[0],
      PILLAR, hashOf(PILLAR_META),
      TOPIC,  hashOf(TOPIC_META),
      FOUNDING, 2, hashOf(FOUNDING_CONTENT),
    ),
    PILLAR,
  );
  return { core, gov, archive, signers, genesis };
}

describe("EvidenceArchive", () => {
  describe("evidence content", () => {
    it("publishes content that hashes to the core's contentHash, and reads it back", async () => {
      const { core, archive } = await deployAll();
      const extra = JSON.stringify({ type: "video", tags: ["navy", "ir"] });
      await expect(archive.publishEvidenceContent(FOUNDING, FOUNDING_CONTENT, extra))
        .to.emit(archive, "EvidenceContentPublished")
        .withArgs(FOUNDING, hashOf(FOUNDING_CONTENT), FOUNDING_CONTENT, extra);
      expect(await archive.evidenceContent(FOUNDING)).to.equal(FOUNDING_CONTENT);
      expect(await archive.evidenceExtra(FOUNDING)).to.equal(extra);
      // Sanity: the stored canonical hashes to the same value the core holds.
      expect(ethers.keccak256(ethers.toUtf8Bytes(await archive.evidenceContent(FOUNDING))))
        .to.equal((await core.getEvidence(FOUNDING)).contentHash);
    });

    it("reverts when the content does not hash to the stored contentHash", async () => {
      const { archive } = await deployAll();
      await expect(archive.publishEvidenceContent(FOUNDING, FOUNDING_CONTENT + " ", "{}"))
        .to.be.revertedWith("content hash mismatch");
    });

    it("reverts for an unknown evidence id", async () => {
      const { archive } = await deployAll();
      await expect(archive.publishEvidenceContent(evidenceId(123456), FOUNDING_CONTENT, "{}"))
        .to.be.revertedWith("unknown evidence");
    });
  });

  describe("node metadata", () => {
    it("publishes pillar + topic meta verified against metaHash", async () => {
      const { archive } = await deployAll();
      await expect(archive.publishNodeMeta(PILLAR, PILLAR_META))
        .to.emit(archive, "NodeMetaPublished").withArgs(PILLAR, hashOf(PILLAR_META), PILLAR_META);
      await archive.publishNodeMeta(TOPIC, TOPIC_META);
      expect(await archive.nodeMeta(PILLAR)).to.equal(PILLAR_META);
      expect(await archive.nodeMeta(TOPIC)).to.equal(TOPIC_META);
    });

    it("reverts on meta mismatch and unknown node", async () => {
      const { archive } = await deployAll();
      await expect(archive.publishNodeMeta(PILLAR, TOPIC_META)).to.be.revertedWith("meta hash mismatch");
      await expect(archive.publishNodeMeta(nodeId("nope"), "{}")).to.be.revertedWith("unknown node");
    });

    it("batch-publishes node meta", async () => {
      const { archive } = await deployAll();
      await archive.publishNodeMetas([PILLAR, TOPIC], [PILLAR_META, TOPIC_META]);
      expect(await archive.nodeMeta(PILLAR)).to.equal(PILLAR_META);
      expect(await archive.nodeMeta(TOPIC)).to.equal(TOPIC_META);
      await expect(archive.publishNodeMetas([PILLAR], [PILLAR_META, TOPIC_META]))
        .to.be.revertedWith("length mismatch");
    });
  });

  describe("notes", () => {
    it("stores note text keyed by the same hash the vote committed (noteHash)", async () => {
      const { archive } = await deployAll();
      const text = "I endorse this — strong primary source.";
      const noteHash = hashOf(text); // == noteHashOf(text) in wallet-impl.js
      await expect(archive.publishNote(text)).to.emit(archive, "NotePublished").withArgs(noteHash, text);
      expect(await archive.noteText(noteHash)).to.equal(text);
    });

    it("rejects empty notes (ZeroHash 'no note' sentinel)", async () => {
      const { archive } = await deployAll();
      await expect(archive.publishNote("")).to.be.revertedWith("empty note");
    });

    it("batch-publishes notes", async () => {
      const { archive } = await deployAll();
      const texts = ["first note", "second note"];
      await archive.publishNotes(texts);
      for (const t of texts) expect(await archive.noteText(hashOf(t))).to.equal(t);
    });
  });

  // M1: bound permanent state-bloat griefing on the two attacker-controllable,
  // non-hash-verified strings (`extra` and note `text`).
  describe("length caps (M1)", () => {
    it("rejects an over-long note and an over-long extra; accepts at the cap", async () => {
      const { archive } = await deployAll();
      const cap = Number(await archive.MAX_NOTE_BYTES());
      await expect(archive.publishNote("x".repeat(cap + 1))).to.be.revertedWith("note too long");
      await expect(archive.publishNote("x".repeat(cap))).to.emit(archive, "NotePublished");

      const xcap = Number(await archive.MAX_EXTRA_BYTES());
      await expect(archive.publishEvidenceContent(FOUNDING, FOUNDING_CONTENT, "y".repeat(xcap + 1)))
        .to.be.revertedWith("extra too long");
      await expect(archive.publishEvidenceContent(FOUNDING, FOUNDING_CONTENT, "y".repeat(xcap)))
        .to.emit(archive, "EvidenceContentPublished");
    });
  });
});
