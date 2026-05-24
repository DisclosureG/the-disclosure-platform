# Contributing

Thanks for your interest in improving The Disclosure Platform! This guide covers
how to set up the project, run the checks, and submit changes.

## Development setup

See the [README](README.md#getting-started) for full setup. In short:

```bash
# Frontend
npm install
cp .env.example .env.local      # fill in your values
npm run dev

# Contracts
cd blockchain
npm install
cp .env.example .env            # set a throwaway DEPLOYER_PRIVATE_KEY
```

## Before you open a pull request

Run the relevant checks and make sure they pass:

```bash
# Frontend builds cleanly
npm run build

# Contracts compile and all tests pass
cd blockchain && npx hardhat compile && npx hardhat test
```

If you change UI behavior, verify it in the browser (`npm run dev`) — type checks
and tests confirm code correctness, not feature correctness.

## Guidelines

- **Keep changes focused.** One logical change per pull request.
- **Match the existing style.** Follow the conventions already in the file you're
  editing; avoid unrelated refactors.
- **Mind the cross-layer invariants.** The contract is the source of truth and
  the Supabase projection is reconciled from chain events. Hashing
  (`contentHash`, `metaHash`, `node_hash`, `bindingId`) must stay byte-identical
  across the frontend (`src/lib/wallet-impl.js`) and the edge functions
  (`verify-attestation`, `audit-content-hash`). See [CLAUDE.md](CLAUDE.md) for
  the data model before touching these.
- **Never commit secrets.** Real keys belong in git-ignored `.env` files only.
- **Smart contract changes** must include or update Hardhat tests and keep the
  full suite green.

## Reporting bugs & vulnerabilities

- Functional bugs: open a
  [GitHub issue](https://github.com/DisclosureG/the-disclosure-platform/issues).
- Security vulnerabilities: follow [SECURITY.md](SECURITY.md) — do **not** file a
  public issue.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
