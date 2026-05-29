// Shared deploy preflight: prints network/deployer/gas context and guards
// against the two ways a mainnet deploy goes wrong —
//   1. deploying to the wrong chain (no confirmation), and
//   2. deploying a non-stripped (oversized) build that fails BscScan verify.
// Reused by deploy-consensus.js, finish-deploy.js, and deploy-archive.js.
const hre = require("hardhat");

// BSC mainnet chainId = 56, testnet = 97, hardhat = 31337.
const MAINNET_CHAIN_ID = 56n;
const HARDHAT_CHAIN_ID = 31337n;

// Returns the chainId (bigint) after running all guards. Throws on any failure.
async function preflight() {
  const [deployer] = await hre.ethers.getSigners();
  // Context logging mirrors scripts/precheck.js so a deploy run is self-documenting.
  const net = await hre.ethers.provider.getNetwork();
  const chainId = net.chainId;
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  const fee = await hre.ethers.provider.getFeeData();

  console.log("=== preflight ===");
  console.log("network name    :", hre.network.name);
  console.log("network chainId :", chainId.toString());
  console.log("deployer addr   :", deployer.address);
  console.log("deployer BNB    :", hre.ethers.formatEther(bal));
  console.log("current gas wei :", fee.gasPrice ? fee.gasPrice.toString() : "n/a");

  // Mainnet guard: irreversible spend + one-shot setGovernance, so require an
  // explicit opt-in env to avoid an accidental real-money deploy.
  if (chainId === MAINNET_CHAIN_ID && process.env.CONFIRM_MAINNET !== "1") {
    throw new Error(
      "Refusing to deploy to BSC mainnet (chainId 56) without CONFIRM_MAINNET=1. " +
      "Re-run with CONFIRM_MAINNET=1 once you are certain.",
    );
  }

  // Size guard: any real network needs the stripped build to fit under EIP-170
  // (only ~360 bytes of headroom). Without STRIP_REVERTS the deployed bytecode
  // both overflows the limit AND won't match a STRIP_REVERTS verify.
  if (chainId !== HARDHAT_CHAIN_ID && !process.env.STRIP_REVERTS) {
    throw new Error(
      `STRIP_REVERTS is required for real-network deploys (chainId ${chainId}). ` +
      `Re-run with STRIP_REVERTS=1 so the build fits under EIP-170 and matches ` +
      `the BscScan verify build, e.g. ` +
      `STRIP_REVERTS=1 npx hardhat run <script> --network ${hre.network.name}`,
    );
  }
  console.log("=================");

  return chainId;
}

module.exports = { preflight, MAINNET_CHAIN_ID, HARDHAT_CHAIN_ID };
