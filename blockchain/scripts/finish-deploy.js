// One-off recovery: the main deploy confirmed the core but an RPC timeout
// interrupted it before PeerGovernance/Lens. This deploys those against the
// existing core (CORE_ADDR) and wires setGovernance, so no gas is wasted
// re-deploying the core. Run with STRIP_REVERTS=1 to match verifiable bytecode.
const hre = require("hardhat");

async function main() {
  const core = process.env.CORE_ADDR;
  if (!core) throw new Error("CORE_ADDR env required");
  const [deployer] = await hre.ethers.getSigners();
  console.log("Finishing deploy as", deployer.address, "against core", core);

  const Gov = await hre.ethers.getContractFactory("PeerGovernance");
  const gov = await Gov.deploy(core);
  await gov.waitForDeployment();
  const govAddr = await gov.getAddress();
  console.log("PeerGovernance deployed to:", govAddr);

  const Lens = await hre.ethers.getContractFactory("EvidenceConsensusLens");
  const lens = await Lens.deploy(core, govAddr);
  await lens.waitForDeployment();
  const lensAddr = await lens.getAddress();
  console.log("EvidenceConsensusLens deployed to:", lensAddr);

  const Core = await hre.ethers.getContractAt("EvidenceConsensus", core);
  const tx = await Core.setGovernance(govAddr);
  await tx.wait();
  console.log("Wired core.governance ->", govAddr);

  console.log("ENV  VITE_CONSENSUS_ADDR=" + core);
  console.log("ENV  VITE_CONSENSUS_GOVERNANCE_ADDR=" + govAddr);
  console.log("ENV  VITE_CONSENSUS_LENS_ADDR=" + lensAddr);
  console.log("ENV  VITE_DEPLOY_BLOCK=" + (await hre.ethers.provider.getBlockNumber()));
}

main().catch(err => { console.error(err); process.exit(1); });
