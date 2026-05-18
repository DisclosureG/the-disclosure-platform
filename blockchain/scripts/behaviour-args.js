// Constructor arguments for BehaviourConsensus, used for bscscan verification
// via `npx hardhat verify --constructor-args scripts/behaviour-args.js <addr>`.
//
// The single argument is the deployed EvidenceConsensus address whose peer
// registry will be read across the contract boundary.

module.exports = [
  process.env.EVIDENCE_CONSENSUS_ADDR ||
    process.env.VITE_CONSENSUS_ADDR ||
    "0x0000000000000000000000000000000000000000",
];
