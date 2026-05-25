const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying EvidenceConsensus with:", deployer.address);

  // Genesis peer set — deployer is peer 0; add more before mainnet
  const genesisPeers   = [deployer.address];
  const genesisHandles = ["Genesis"];

  // Seed-phase K — minimum activePeerCount before public nominatePeer unlocks.
  // While count < K, only `addPeer` (owner) can add peers.  Closes the
  // Genesis-1 Sybil window.  Override with SEED_PHASE_K env var.
  const seedPhaseK = Number(process.env.SEED_PHASE_K ?? 5);
  console.log("Seed-phase K:", seedPhaseK);

  const Factory = await hre.ethers.getContractFactory("EvidenceConsensus");

  // Guard against shipping an oversized contract: EIP-170 caps deployed bytecode
  // at 24576 bytes. The full-strings build is ~27.5 KB; STRIP_REVERTS=1 brings it
  // under. Fail fast with a clear instruction rather than a cryptic on-chain revert.
  const runtimeBytes = (hre.artifacts.readArtifactSync("EvidenceConsensus").deployedBytecode.length - 2) / 2;
  console.log("Runtime bytecode size:", runtimeBytes, "bytes (limit 24576)");
  if (runtimeBytes > 24576) {
    throw new Error(
      `Deployed bytecode is ${runtimeBytes} bytes (> 24576). Re-run with STRIP_REVERTS=1, ` +
      `e.g. STRIP_REVERTS=1 npx hardhat run scripts/deploy-consensus.js --network ${hre.network.name}`,
    );
  }

  const contract = await Factory.deploy(genesisPeers, genesisHandles, seedPhaseK);
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log("EvidenceConsensus deployed to:", addr);

  // Peer-governance sidecar: holds the nominee + revocation flows moved off the
  // core to stay under EIP-170. It mutates the core's peer set through the
  // governance-gated gAddPeer/gRemovePeer, wired once via setGovernance below.
  const GovFactory = await hre.ethers.getContractFactory("PeerGovernance");
  const gov = await GovFactory.deploy(addr);
  await gov.waitForDeployment();
  const govAddr = await gov.getAddress();
  console.log("PeerGovernance deployed to:", govAddr);

  // One-shot wiring: link the governance contract so it can admit/revoke peers.
  const wireTx = await contract.setGovernance(govAddr);
  await wireTx.wait();
  console.log("Wired core.governance ->", govAddr);

  // Read-only Lens sidecar: holds the peer/nominee/proposal aggregation views
  // moved off the core to stay under EIP-170. No storage, no privileges — it
  // only reads the core's and governance's public state. Deployed after both.
  const LensFactory = await hre.ethers.getContractFactory("EvidenceConsensusLens");
  const lens = await LensFactory.deploy(addr, govAddr);
  await lens.waitForDeployment();
  const lensAddr = await lens.getAddress();
  console.log("EvidenceConsensusLens deployed to:", lensAddr);

  console.log("Add to .env:  VITE_CONSENSUS_ADDR=" + addr);
  console.log("Add to .env:  VITE_CONSENSUS_GOVERNANCE_ADDR=" + govAddr);
  console.log("Add to .env:  VITE_CONSENSUS_LENS_ADDR=" + lensAddr);
  console.log("Add to .env:  VITE_DEPLOY_BLOCK=" + (await hre.ethers.provider.getBlockNumber()));
}

main().catch(err => { console.error(err); process.exit(1); });
