const hre = require("hardhat");

async function main() {
  const recipient = process.env.RECIPIENT;
  const dogeAddr  = process.env.DOGE_ADDR;
  const pepeAddr  = process.env.PEPE_ADDR;

  if (!recipient || !dogeAddr || !pepeAddr) {
    console.error("Usage: RECIPIENT=0x... DOGE_ADDR=0x... PEPE_ADDR=0x... npx hardhat run scripts/mint-to.js --network localhost");
    process.exit(1);
  }

  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
  const doge = MockERC20.attach(dogeAddr);
  const pepe = MockERC20.attach(pepeAddr);

  await doge.mint(recipient, hre.ethers.parseUnits("1000000", 8));
  await pepe.mint(recipient, hre.ethers.parseUnits("1000000000000", 18));

  console.log(`✅ Minted to ${recipient}`);
  console.log(`   1,000,000 DOGE (8 decimals) · ${dogeAddr}`);
  console.log(`   1,000,000,000,000 PEPE (18 decimals) · ${pepeAddr}`);
  console.log(`\nIn MetaMask → Import token → paste each address above to see balances.`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
