# Ethereum Entity Registry

A shared on-chain registry that maps off-chain identifiers (GitHub repos, DNS domains) to Ethereum addresses — deployed once per chain, readable by any protocol.

Every identifier gets a deterministic deposit address (an identity account) before its owner has ever interacted with Ethereum. Funds accumulate there until the owner claims and takes control.

> **Status:** Research prototype. Contracts are not audited. Do not use in production.

See [OVERVIEW.md](./OVERVIEW.md) for the problem statement, design rationale, and comparisons with ENS, Drips, and EAS. See [spec.md](./spec.md) for the full research paper.

## Install

```sh
npm install @ethereum-entity-registry/sdk
```

## Resolve an Identifier

```ts
import { EntityRegistrySDK } from "@ethereum-entity-registry/sdk";

const sdk = new EntityRegistrySDK();

// Accepts URLs, namespace:value, or domain names
const state = await sdk.registry.resolve("github.com/org/repo");
// state.id             — bytes32 identifier
// state.depositAddress — where funders should send tokens (computed locally, no RPC)

// Pass a token address to also fetch the balance
const state = await sdk.registry.resolve("github.com/org/repo", tokenAddress);
// state.balance        — token balance at the deposit address

// All of these work:
sdk.registry.resolve("github:org/repo");
sdk.registry.resolve("https://github.com/org/repo");
sdk.registry.resolve("example.com");
sdk.registry.resolve("npmjs.com/package/foo");
```

## Fund an Identifier

Transfer any ERC-20 directly to the deposit address — no registry interaction required:

```ts
await token.transfer(state.depositAddress, amount);
```

## Claim an Identifier

Ownership is proven via a namespace-specific verifier. The web app handles verification and returns a signed proof.

### GitHub

```ts
// 1. Redirect the user to the claim gateway (handles OAuth)
window.location.href = `/claim/github?owner=org&repo=repo&claimant=${address}`;

// 2. After OAuth, the gateway redirects back with the proof
const proof = new URLSearchParams(window.location.search).get("proof");

// 3. Submit the claim on-chain
await sdk.registry.claim("github.com/org/repo", proof);
```

### DNS


```ts
// 1. Add a TXT record: _eth-canonical.example.com → "0xYourAddress"

// 2. Request a proof
const res = await fetch("/api/proof/dns", {
  method: "POST",
  body: JSON.stringify({ domain: "example.com", claimant: address }),
});
const { proof } = await res.json();

// 3. Submit the claim on-chain
await sdk.registry.claim("example.com", proof);
```

## Execute Actions

Once claimed, the owner controls the identity account via `execute`. The SDK provides helpers for common operations:

```ts
// Transfer ERC-20 tokens out of the identity account
const { target, data } = sdk.account.encodeERC20Transfer(tokenAddress, recipient, amount);
await sdk.account.execute(state.depositAddress, target, data);

// Withdraw from a Splits Warehouse
const call = sdk.account.encodeWarehouseWithdraw(warehouseAddress, state.depositAddress, tokenAddress);
await sdk.account.execute(state.depositAddress, call.target, call.data);
```

Only the registered owner can call `execute` — the identity account verifies ownership through the registry.

## On-Chain Integration

```solidity
import {IEntityRegistry} from "@ethereum-entity-registry/contracts/contracts/IEntityRegistry.sol";

bytes32 id = keccak256(abi.encode("github", "org/repo"));
address owner = IEntityRegistry(registry).ownerOf(id);
```

`ownerOf` resolves through aliases transparently.

## React Hooks

```tsx
import {
  EntityRegistryProvider,
  useIdentifier,
  useClaim,
} from "@ethereum-entity-registry/sdk";

function App() {
  return <EntityRegistryProvider>{/* ... */}</EntityRegistryProvider>;
}

function IdentifierCard({ id }: { id: `0x${string}` }) {
  const { data } = useIdentifier(id);
  const claim = useClaim();

  return (
    <div>
      <p>Owner: {data?.owner ?? "Unclaimed"}</p>
      <p>Deposit: {data?.accountAddress}</p>
    </div>
  );
}
```

## Packages

```
packages/
  contracts/   — Solidity contracts (EntityRegistry, IdentityAccount, verifiers)
  sdk/         — TypeScript SDK + React hooks
  indexer/     — Ponder event indexer
  ui/          — Shared Shadcn UI components
apps/
  web/         — Next.js frontend
  docs/        — Documentation site (concepts, architecture, integration, security)
```

## Documentation

- [OVERVIEW.md](./OVERVIEW.md) — What this is and why it exists
- [spec.md](./spec.md) — Full research paper (design trade-offs, open questions)
- [Open Privy infrastructure review](./erc/open-privy-infrastructure-review.md) — Email-first onboarding, privacy, relayers, reverse lookup, and implementation roadmap
- [Privacy-preserving email identity](./erc/privacy-preserving-email-identity.md) — Focused proposal for hash-only email claims
- [Documentation site](./apps/docs/) — Concepts, architecture, integration guide, security model, requirements
