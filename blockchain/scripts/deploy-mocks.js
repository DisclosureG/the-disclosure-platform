const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");

  const doge = await MockERC20.deploy("Mock DOGE", "DOGE", 8);
  await doge.waitForDeployment();

  const pepe = await MockERC20.deploy("Mock PEPE", "PEPE", 18);
  await pepe.waitForDeployment();

  const dogeAddr = await doge.getAddress();
  const pepeAddr = await pepe.getAddress();

  // Mint 1 000 000 DOGE and 1 000 000 000 000 PEPE to deployer for testing
  await doge.mint(deployer.address, hre.ethers.parseUnits("1000000", 8));
  await pepe.mint(deployer.address, hre.ethers.parseUnits("1000000000000", 18));

  console.log("MockDOGE:", dogeAddr);
  console.log("MockPEPE:", pepeAddr);
  console.log("\nUpdate PurchaseModal.jsx:");
  console.log(`  const DOGE_BEP20 = "${dogeAddr}";`);
  console.log(`  const PEPE_BEP20 = "${pepeAddr}";`);
  console.log(`\nAdd MockDOGE to MetaMask: contract ${dogeAddr}, decimals 8`);
  console.log(`Add MockPEPE to MetaMask: contract ${pepeAddr}, decimals 18`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
