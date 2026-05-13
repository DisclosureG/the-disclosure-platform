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
  const contract = await Factory.deploy(genesisPeers, genesisHandles, seedPhaseK);
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log("EvidenceConsensus deployed to:", addr);
  console.log("Add to .env:  VITE_CONSENSUS_ADDR=" + addr);
  console.log("Add to .env:  VITE_DEPLOY_BLOCK=" + (await hre.ethers.provider.getBlockNumber()));
}

main().catch(err => { console.error(err); process.exit(1); });
