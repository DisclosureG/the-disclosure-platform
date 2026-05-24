require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const DEPLOYER_KEY    = process.env.DEPLOYER_PRIVATE_KEY;
const BSC_TESTNET_RPC = process.env.BSC_TESTNET_RPC || "https://bsc-testnet-rpc.publicnode.com";
const BSC_MAINNET_RPC = process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org/";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || "";

// EIP-170 caps deployed bytecode at 24576 bytes on real chains. With every
// feature enabled (taxonomy retirement, per-round eligibility, etc.) the
// contract compiles to ~27.5 KB with revert-reason strings, and ~23.7 KB once
// those strings are stripped. We therefore:
//   • keep full revert strings for local tests (Hardhat network ignores the size
//     limit via allowUnlimitedContractSize, so the test suite exercises the exact
//     logic AND keeps its `revertedWith("…")` assertions); and
//   • strip revert strings for any real deployment by setting STRIP_REVERTS=1,
//     which brings the runtime bytecode under the limit. Logic and storage are
//     byte-for-byte identical; only the human-readable revert reasons differ.
// Deploy + verify must both run with STRIP_REVERTS=1 so BscScan verification
// matches. The deploy script hard-fails if the artifact exceeds the limit.
const STRIP_REVERTS = !!process.env.STRIP_REVERTS;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      ...(STRIP_REVERTS ? { debug: { revertStrings: "strip" } } : {}),
    },
  },
  networks: {
    hardhat:  { chainId: 31337, allowUnlimitedContractSize: true },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    bscTestnet: {
      url:      BSC_TESTNET_RPC,
      chainId:  97,
      ...(DEPLOYER_KEY ? { accounts: [DEPLOYER_KEY] } : {}),
      gasPrice: 5_000_000_000,
    },
    bscMainnet: {
      url:      BSC_MAINNET_RPC,
      chainId:  56,
      ...(DEPLOYER_KEY ? { accounts: [DEPLOYER_KEY] } : {}),
      gasPrice: 1_000_000_000,
    },
  },
  etherscan: {
    apiKey: BSCSCAN_API_KEY,
    customChains: [
      {
        network:  "bscTestnet",
        chainId:  97,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=97",
          browserURL: "https://testnet.bscscan.com",
        },
      },
      {
        network:  "bscMainnet",
        chainId:  56,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=56",
          browserURL: "https://bscscan.com",
        },
      },
    ],
  },
};
