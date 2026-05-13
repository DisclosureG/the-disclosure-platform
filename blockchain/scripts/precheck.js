const hre = require("hardhat");

async function main() {
  const [d] = await hre.ethers.getSigners();
  const bal = await hre.ethers.provider.getBalance(d.address);
  const net = await hre.ethers.provider.getNetwork();
  const fee = await hre.ethers.provider.getFeeData();
  console.log("network chainId :", net.chainId.toString());
  console.log("deployer addr   :", d.address);
  console.log("deployer BNB    :", hre.ethers.formatEther(bal));
  console.log("current gas wei :", fee.gasPrice ? fee.gasPrice.toString() : "n/a");
}

main().catch(e => { console.error(e); process.exit(1); });
