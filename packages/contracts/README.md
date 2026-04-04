# @ethereum-entity-registry/contracts

Solidity smart contracts for the Entity Registry.

## Contracts

| Contract | Purpose |
|---|---|
| **EntityRegistry** | Ownable singleton. Manages identifier ownership, identity account deployment, and verifier registration. Holds no funds. |
| **IdentityAccount** | Per-identifier smart account deployed as a `BeaconProxy` via CREATE2. Accepts ETH and ERC-20 deposits. The registered owner calls `execute` to interact with any contract. This implementation also includes an optional reclaim extension via `setReclaim`. |
| **AccountFactory** | Platform-specific factory with reclaim config. Deploys `IdentityAccount` proxies per identifier at deterministic addresses and configures reclaim on deploy. Factory selection is a deployment concern, not a protocol-wide default. |
| **IEntityRegistry** | Minimal interface consumed by `IdentityAccount` to resolve the registered owner. |
| **IVerifier** | Verifier interface — one `verify(id, claimant, proof)` function. Implement to add a new namespace. Namespace labels are lowercase ASCII matching `[a-z0-9-]+`. |
| **VerifierOracle** | Abstract base: EIP-712 typed-data proof verification against a trusted signer. |
| **VerifierGitHub** | Extends `VerifierOracle`. Oracle confirms GitHub repo admin access via OAuth. |
| **VerifierDns** | Extends `VerifierOracle`. Oracle confirms domain ownership via DNS TXT record. |
| **TestToken** | Minimal ERC-20 for local development only. |

## Source layout

```
contracts/
  EntityRegistry.sol     — registry singleton
  IdentityAccount.sol       — per-identifier smart account (execute + optional setReclaim)
  AccountFactory.sol        — platform-specific factory with reclaim config
  IEntityRegistry.sol    — interface for IdentityAccount
  IVerifier.sol             — verifier interface
  verifiers/
    VerifierOracle.sol      — EIP-712 oracle base
    VerifierGitHub.sol      — GitHub verifier
    VerifierDns.sol         — DNS verifier
  splits/                   — bundled 0xSplits contracts (not used by core; may be removed)
  mock/
    TestToken.sol           — ERC-20 test token
    Multicall3.sol          — local Multicall3 mock
ignition/
  modules/
    Registry.ts             — local dev (deploys everything)
    Registry.sepolia.ts     — Sepolia (with test tokens)
    Registry.production.ts  — mainnet/production (no test tokens)
    TestTokens.ts           — test token sub-module
  parameters/
    hardhat.json
    sepolia.json
    mainnet.json
```

## Local development

### Run tests

```bash
pnpm hardhat test
```

### Start a local node and deploy

```bash
# Terminal 1
pnpm hardhat node

# Terminal 2
pnpm hardhat ignition deploy ignition/modules/Registry.ts --network localhost
```

The local module deploys: `IdentityAccount` (implementation), `EntityRegistry`, `DnsVerifier`, `GitHubVerifier`, and test tokens (USDC, WETH, DAI). The deployer account is set as both `admin` and `trustedSigner`.

### Generate deployments.json

After any deployment, regenerate the shared deployments file used by the SDK, indexer, and web app:

```bash
pnpm run generate-abi
```

This writes `deployments.json` (addresses + ABIs) into `packages/sdk`, `packages/indexer`, and `apps/web`.

## Sepolia

### 1. Environment

```bash
# Recommended: Hardhat keystore
pnpm hardhat keystore set SEPOLIA_RPC_URL
pnpm hardhat keystore set SEPOLIA_PRIVATE_KEY

# Or .env
# SEPOLIA_RPC_URL=...
# SEPOLIA_PRIVATE_KEY=0x...
```

### 2. Set parameters

Edit `ignition/parameters/sepolia.json` with your addresses:

```json
{
  "DeployModuleSepolia": {
    "admin": "0xYourAdminAddress",
    "trustedSigner": "0xYourOracleSignerAddress"
  }
}
```

### 3. Deploy

```bash
pnpm hardhat ignition deploy ignition/modules/Registry.sepolia.ts \
  --network sepolia \
  --parameters ignition/parameters/sepolia.json
```

Deploys `IdentityAccount` (impl), `EntityRegistry`, `DnsVerifier`, `GitHubVerifier`, and test tokens.

For mainnet (no test tokens):

```bash
pnpm hardhat ignition deploy ignition/modules/Registry.production.ts \
  --network mainnet \
  --parameters ignition/parameters/mainnet.json
```

### 4. Generate ABIs

```bash
pnpm run generate-abi
```

### 5. Verify on Etherscan

```bash
pnpm hardhat verify --network sepolia <ADDRESS> <CONSTRUCTOR_ARGS>
```

## Deployment summary

| Network | Module | Parameters |
|---|---|---|
| Local (Hardhat) | `Registry.ts` | none — deployer is admin + signer |
| Sepolia | `Registry.sepolia.ts` | `ignition/parameters/sepolia.json` |
| Mainnet | `Registry.production.ts` | `ignition/parameters/mainnet.json` |


## Troubleshooting

- **"Deployment already exists"** — Ignition reuses existing deployments. To redeploy from scratch, remove `ignition/deployments/chain-<chainId>/` then run the deploy command again.
- **"account already deployed"** — `deployAccount` reverts if the proxy already exists. Check `predictAddress` first.
- **Verifier rejects proof** — Ensure the `trustedSigner` in the parameters matches the oracle backend's signing key, and that proofs haven't expired (default TTL: 1 hour).
- **Indexer not syncing** — Check that `ponder.config.ts` references the correct registry address from `deployments.json` and that `PONDER_RPC_URL_<chainId>` is set.
