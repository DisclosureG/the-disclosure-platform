const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const AUTHOR = process.env.AUTHOR_ADDRESS || deployer.address;
  console.log("Author (profit recipient):", AUTHOR);

  const BookEscrow = await hre.ethers.getContractFactory("BookEscrow");
  const escrow = await BookEscrow.deploy(AUTHOR);
  await escrow.waitForDeployment();

  const addr = await escrow.getAddress();
  console.log("\n✅ BookEscrow deployed to:", addr);
  console.log("   Network:", hre.network.name);
  console.log("   Author:", AUTHOR);

  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");

    const doge = await MockERC20.deploy("Mock DOGE", "DOGE", 8);
    await doge.waitForDeployment();

    const pepe = await MockERC20.deploy("Mock PEPE", "PEPE", 18);
    await pepe.waitForDeployment();

    console.log("\n🐕 MockDOGE deployed to:", await doge.getAddress());
    console.log("🐸 MockPEPE deployed to:", await pepe.getAddress());
    console.log("\nPaste these into PurchaseModal.jsx:");
    console.log(`  ESCROW_ADDR = "${addr}"`);
    console.log(`  DOGE_ADDR   = "${await doge.getAddress()}"`);
    console.log(`  PEPE_ADDR   = "${await pepe.getAddress()}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
