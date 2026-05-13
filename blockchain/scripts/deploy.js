const hre = require("hardhat");

// BSC mainnet BEP-20 addresses
const DOGE_BSC = "0xf328840bAdbAd51a207f2A6618D75567F2dEEc07";
const PEPE_BSC = "0xb642364705c6e009299d32eba9Abbcb54e197065";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const AUTHOR = process.env.AUTHOR_ADDRESS || deployer.address;
  console.log("Author (profit recipient):", AUTHOR);

  const isLocal = hre.network.name === "hardhat" || hre.network.name === "localhost";

  let dogeAddr, pepeAddr;

  if (isLocal) {
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");

    const doge = await MockERC20.deploy("Mock DOGE", "DOGE", 8);
    await doge.waitForDeployment();
    dogeAddr = await doge.getAddress();

    const pepe = await MockERC20.deploy("Mock PEPE", "PEPE", 18);
    await pepe.waitForDeployment();
    pepeAddr = await pepe.getAddress();

    console.log("\n🐕 MockDOGE deployed to:", dogeAddr);
    console.log("🐸 MockPEPE deployed to:", pepeAddr);
  } else {
    dogeAddr = process.env.DOGE_ADDRESS || DOGE_BSC;
    pepeAddr = process.env.PEPE_ADDRESS || PEPE_BSC;
    console.log("DOGE token:", dogeAddr);
    console.log("PEPE token:", pepeAddr);
  }

  const BookEscrow = await hre.ethers.getContractFactory("BookEscrow");
  const escrow = await BookEscrow.deploy(AUTHOR, dogeAddr, pepeAddr);
  await escrow.waitForDeployment();

  const addr = await escrow.getAddress();
  console.log("\n✅ BookEscrow deployed to:", addr);
  console.log("   Network:", hre.network.name);
  console.log("   Author:", AUTHOR);
  console.log("   tokenA (DOGE):", dogeAddr);
  console.log("   tokenB (PEPE):", pepeAddr);

  if (isLocal) {
    console.log("\nPaste these into your .env:");
    console.log(`  VITE_ESCROW_ADDR="${addr}"`);
    console.log(`  VITE_DOGE_ADDR="${dogeAddr}"`);
    console.log(`  VITE_PEPE_ADDR="${pepeAddr}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
