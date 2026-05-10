require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const DEPLOYER_KEY    = process.env.DEPLOYER_PRIVATE_KEY;
const BSC_TESTNET_RPC = process.env.BSC_TESTNET_RPC    || "https://bsc-testnet-rpc.publicnode.com";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY    || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat:  { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    bscTestnet: {
      url:      BSC_TESTNET_RPC,
      chainId:  97,
      ...(DEPLOYER_KEY ? { accounts: [DEPLOYER_KEY] } : {}),
      gasPrice: 5_000_000_000,
    },
  },
  etherscan: {
    apiKey: { bscTestnet: BSCSCAN_API_KEY },
    customChains: [
      {
        network:  "bscTestnet",
        chainId:  97,
        urls: {
          apiURL:     "https://api-testnet.bscscan.com/api",
          browserURL: "https://testnet.bscscan.com",
        },
      },
    ],
  },
};
