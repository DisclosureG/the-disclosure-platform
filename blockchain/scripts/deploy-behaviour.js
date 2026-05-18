const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying BehaviourConsensus with:", deployer.address);

  const peerSource =
    process.env.EVIDENCE_CONSENSUS_ADDR ||
    process.env.VITE_CONSENSUS_ADDR;

  if (!peerSource) {
    throw new Error(
      "EVIDENCE_CONSENSUS_ADDR (or VITE_CONSENSUS_ADDR) must be set — " +
      "BehaviourConsensus reads its peer registry from the deployed " +
      "EvidenceConsensus contract."
    );
  }

  if (!hre.ethers.isAddress(peerSource)) {
    throw new Error(`Invalid peer source address: ${peerSource}`);
  }

  console.log("Peer source (EvidenceConsensus):", peerSource);

  const Factory  = await hre.ethers.getContractFactory("BehaviourConsensus");
  const contract = await Factory.deploy(peerSource);
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log("BehaviourConsensus deployed to:", addr);
  console.log("Add to .env:  VITE_BEHAVIOUR_CONSENSUS_ADDR=" + addr);
  console.log("Add to .env:  VITE_BEHAVIOUR_DEPLOY_BLOCK=" + (await hre.ethers.provider.getBlockNumber()));
}

main().catch(err => { console.error(err); process.exit(1); });
