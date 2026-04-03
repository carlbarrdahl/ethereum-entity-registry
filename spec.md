# Entity Registry

**A shared on-chain primitive for addressing off-chain entities on Ethereum.**

---

## Overview

Many entities that matter to Ethereum — open source repositories, DNS domains, developer communities — exist primarily off-chain and have no Ethereum address. Any protocol that wants to send value or data to them must either require the entity to register an address first, or rely on a trusted intermediary to resolve one on their behalf.

The Entity Registry eliminates both constraints. It maps off-chain identifiers to Ethereum addresses through pluggable, upgradeable verification, and assigns every identifier a deterministic deposit address before anyone has registered anything. A protocol can address any GitHub repository or DNS domain and deposit funds to it today, without the entity's participation. The entity claims the funds whenever they're ready.

The registry itself is a thin public-good primitive: deployed once per chain, no token, no fee, no privileged operators beyond verifier governance. Any protocol can read it. Any entity can register.

---

## Problem

Ethereum's identity infrastructure addresses humans well — ENS maps readable names to addresses, EAS provides attestation schemas for assertions about people. But off-chain _entities_ — the GitHub repository that produces a widely-used library, the domain that represents a project, the package that downstream protocols depend on — have no standard Ethereum address.

This creates a coordination failure. A grants protocol wants to fund `github:ethereum/go-ethereum`. A dependency funding tool wants to route contributions to every package in a supply chain. A DAO wants to send a payment to a domain. In each case, the protocol faces the same choice:

- **Require registration first.** The entity must proactively create a wallet, claim an identifier, and be reachable before any interaction can occur. This excludes the long tail of valuable entities that haven't engaged with Ethereum yet.
- **Use a trusted intermediary.** Delegate resolution to a backend service or oracle. This centralises a critical mapping and creates an attack surface.

Existing partial solutions don't close the gap:

- **ENS** is human-centric and requires proactive registration. It doesn't model repositories, domains as entities, or package namespaces.
- **EAS** provides attestation infrastructure but no claiming mechanism or canonical identifier scheme for off-chain entities.
- **Drips** maps GitHub repositories to addresses and supports pre-funding, but uses an application-specific oracle and is not designed as a shared primitive.

Every protocol that needs to address off-chain entities currently builds its own bespoke resolution system. The Entity Registry is a shared layer so they don't have to.

---

## Design

### Identifiers

Every identifier is a `(namespace, string)` pair:

| Namespace | Example string | Identifies          |
| --------- | -------------- | ------------------- |
| `github`  | `org/repo`     | A GitHub repository |
| `dns`     | `example.com`  | A DNS domain        |
| `npm`     | `package-name` | An npm package      |

The on-chain identifier is a single `bytes32`:

```solidity
bytes32 id = keccak256(abi.encode(namespace, canonicalString))
```

`abi.encode` (length-prefixed) is used rather than `abi.encodePacked` to prevent collisions between namespace/string pairs that share a common concatenation — e.g. `"githu"+"borg/repo"` vs `"github"+"org/repo"`.

Normalisation rules — lowercase, trailing slash removal, Unicode handling — are namespace-specific and enforced off-chain by verifiers and frontends. The contract hashes whatever strings are passed to it; consistency is the caller's responsibility.

### Registrants

When an entity proves ownership of an identifier, the registry records:

```
id → registrant address
```

The registrant address is any Ethereum address the entity controls — an EOA, a multisig, a smart contract. There is no transfer function; the only way to change the registered address is to revoke and re-claim with a new proof. This ties the registered address to the entity's proven ownership at claim time.

### Verification

The registry delegates proof verification to a per-namespace `IVerifier` contract:

```solidity
interface IVerifier {
    function verify(bytes32 id, address claimant, bytes calldata proof) external returns (bool);
}
```

Any implementation is valid. The current reference verifiers use an oracle model: a trusted backend confirms ownership off-chain (GitHub OAuth for repositories, DNS TXT record for domains) and signs an EIP-712 proof. The proof is submitted on-chain and verified by the `OracleVerifier` base contract.

The interface is designed so oracle verifiers can be replaced with ZK-based verifiers — vlayer, TLSNotary, DNSSEC — as that tooling matures, with no changes to the registry. Existing claims are unaffected when a verifier is upgraded.

EIP-712 domain separation binds proofs to a specific chain and registry address. Proofs include a claimant address and an expiry timestamp, preventing both cross-deployment replay and use by any sender other than the intended claimant.

### Linking

An entity may control multiple identifiers — a GitHub organisation and a DNS domain, for example. After claiming both independently, the registrant can link them:

```solidity
registry.linkIds(primaryId, [aliasId1, aliasId2])
```

Linked aliases resolve to the primary's registrant. `ownerOf(aliasId)` returns the primary's registrant address transparently. Aliases can be unlinked at any time, restoring them as independently registered identifiers.

### Revocation

A registrant can voluntarily revoke their claim, returning the identifier to unclaimed state. Funds held at the deposit address remain there and are claimable by whoever registers the identifier next.

If the identifier has aliases, those must be unlinked before revocation. Any aliases not unlinked become stale (resolve to `address(0)`) and are cleared automatically the next time that alias identifier is claimed.

### Identifier Renames

Off-chain identifiers can change their canonical string — a GitHub repo can be renamed, a package can move to a new scope. When this happens, the old and new `bytes32` hashes are completely unrelated. The old identifier still resolves to the original owner; the new one resolves to `address(0)`.

The recommended migration is claim-and-link:

1. **Claim** the new identifier — the owner still controls the entity, so any verifier (oracle or ZK) can produce a valid proof for the new canonical string.
2. **Link** the old identifier as an alias of the new one via `linkIds(newId, [oldId])` — the owner holds both on-chain, so linking succeeds.

After linking, both identifiers resolve to the same address. Protocols that cached the old identifier continue to resolve correctly. Both oracle and ZK verifiers support this flow — the verification target is the entity at its current canonical string, not the historical one.

If the owner does not act, the old claim becomes stale. Time-bounded claims mitigate this: the owner cannot renew a proof for a canonical string that no longer resolves to a valid entity. A challenge mechanism — where a third party proves the registrant no longer controls the entity — is an open research question.

---

## Registry Contract

The minimal interface for on-chain consumers:

```solidity
interface IEntityRegistry {
    /// @return The registrant address for `id`, resolving through any alias.
    ///         Returns address(0) if unclaimed.
    function ownerOf(bytes32 id) external view returns (address);
}
```

A contract that needs to resolve an identifier to an address and nothing else depends only on this interface. It has no dependency on verifier contracts, the pre-funding module, or any other component.

The full registry interface:

```solidity
// Identifier computation
function toId(string namespace, string canonicalString) external pure returns (bytes32);
function canonicalOf(bytes32 id) external view returns (bytes32);
function ownerOf(bytes32 id) external view returns (address);

// Registration
function claim(string namespace, string canonicalString, bytes proof) external;
function revoke(string namespace, string canonicalString) external;

// Linking
function linkIds(bytes32 primaryId, bytes32[] aliasIds) external;
function unlinkIds(bytes32 primaryId, bytes32[] aliasIds) external;

// Admin
function setVerifier(string namespace, address verifier) external; // onlyOwner
```

The registry holds no funds and executes no financial logic. It is a pure ownership record. The only privileged function is `setVerifier` — registering or replacing a verifier contract for a namespace.

---

## Deterministic Addressing

Every identifier has a corresponding Ethereum address that any client can compute locally, before the identifier is registered, using CREATE2:

```ts
const id = toId("github", "org/repo");
const depositAddress = resolveDepositAddress(id, factoryAddress, beaconAddress);
```

This address is stable: it does not change if ownership changes, and it does not change if the escrow implementation behind it is upgraded.

**The key property: a protocol can address any identifier and send funds to it before the entity has ever interacted with Ethereum.**

This is the feature that makes the registry useful as a shared primitive rather than just a naming service. A grants protocol can route funding to `github:org/repo` without coordinating with the maintainers. A dependency funding tool can allocate to every package in a supply chain regardless of whether any of those packages have an Ethereum presence. The entities claim the funds whenever they're ready.

This differs from ENS, which requires proactive registration before the name resolves to anything. The deposit address for any identifier exists from the moment the registry is deployed — it's a pure function of the identifier and the factory address.

---

## Pre-funding Module

The deterministic address property is implemented through an optional companion module: `EscrowFactory` and `ClaimableEscrow`. This module is architecturally separate from the registry. The registry does not depend on it, and protocols that only need identity resolution have no reason to interact with it.

### EscrowFactory

The factory owns an `UpgradeableBeacon` and deploys one `BeaconProxy` per identifier on demand. Anyone can deploy an escrow for any identifier — it is not gated on the identifier being claimed.

```solidity
contract EscrowFactory {
    UpgradeableBeacon public immutable beacon;
    IEntityRegistry public immutable registry;

    /// @notice Returns the deterministic deposit address for `id`.
    ///         Pure computation — no on-chain state required.
    function predictAddress(bytes32 id) external view returns (address);

    /// @notice Deploys the ClaimableEscrow proxy for `id` if not yet deployed.
    function deployEscrow(bytes32 id) external returns (address);

    /// @notice Upgrade the escrow implementation for all proxies.
    function upgradeEscrow(address newImpl) external; // onlyOwner
}
```

The deposit address for an identifier depends on the factory address, the beacon address, and the identifier — not on the escrow implementation address. Implementation upgrades via the beacon change the logic behind every proxy without changing any deposit address.

### ClaimableEscrow

Each identifier's proxy holds accumulated funds and handles withdrawal to the registrant. It supports two funding paths simultaneously:

1. **Direct ERC-20 transfers** — any `token.transfer(depositAddress, amount)` accumulates as the proxy's own token balance.
2. **Splits Warehouse deposits** — protocols that route funds through the Splits Warehouse using the deposit address as a recipient accumulate a warehouse balance under that address.

Both paths are swept in a single `withdraw(token)` call:

```solidity
function withdraw(address token) external {
    address registrant = registry.ownerOf(id);
    require(registrant != address(0), "ClaimableEscrow: not yet claimed");

    // Pull any Splits Warehouse balance first.
    uint256 warehouseBalance = warehouse.balanceOf(address(this), uint256(uint160(token)));
    if (warehouseBalance > 1) {
        warehouse.withdraw(address(this), token);
    }

    // Transfer combined balance to registrant.
    uint256 total = IERC20(token).balanceOf(address(this));
    require(total > 0, "ClaimableEscrow: nothing to withdraw");
    IERC20(token).safeTransfer(registrant, total);

    emit Withdrawn(token, registrant, total);
}
```

Anyone can call `withdraw` — funds always go to the registrant, not the caller. This allows a frontend or keeper to sweep on the registrant's behalf.

If ownership of an identifier changes (revoke and re-claim), the escrow sends funds to whoever is currently registered. The deposit address is stable; the destination is determined at withdrawal time.

---

## Integration Patterns

### On-chain consumer

A contract that needs to route funds to an identifier only needs `IEntityRegistry`:

```solidity
bytes32 id = keccak256(abi.encode("github", "org/repo"));
address registrant = IEntityRegistry(registry).ownerOf(id);

if (registrant != address(0)) {
    // Identifier is claimed — send directly to registrant.
    token.transfer(registrant, amount);
} else {
    // Identifier is unclaimed — send to deposit address.
    token.transfer(depositAddress, amount);
}
```

`ownerOf` resolves through aliases transparently. No special handling is needed for linked identifiers.

### Frontend and SDK

Deposit address computation requires no RPC call:

```ts
// Pure local computation — no network call required
const id = toId("github", "org/repo");
const depositAddress = resolveDepositAddress(id, factoryAddress, beaconAddress);

// Resolve current registrant — one RPC call
const registrant = await registry.ownerOf(id); // null if unclaimed

// Full claimable balance — checks both direct ERC-20 and warehouse balances
const balance = await getClaimableBalance(
  depositAddress,
  token,
  warehouseAddress,
);
```

For protocols building allocation systems — grant programs, funding distributions, dependency tooling — the recommended resolution flow at allocation creation time is:

- **If claimed:** use the registrant address directly as the allocation recipient. Funds flow to the registrant's warehouse balance and are withdrawn normally.
- **If unclaimed:** use `predictAddress(id)` as the allocation recipient. Funds accumulate in the escrow until the identifier is claimed, at which point the registrant calls `withdraw`.

The resolved address is stored as a plain Ethereum address in the upstream protocol. No knowledge of the registry is required at distribution time.

### Registrant: claiming and withdrawing

1. Obtain a proof from the signing service for the relevant namespace (GitHub OAuth or DNS TXT record).
2. Call `registry.claim(namespace, canonicalString, proof)`. The registry verifies the proof and records the registrant address. The escrow proxy is deployed at this point if not already deployed.
3. Call `escrow.withdraw(tokenAddress)` on the deposit address to sweep any accumulated funds.

```ts
// Step 1: generate proof via backend service
const proof = await generateGithubProof({ accessToken, owner, repo, claimant, ... })

// Step 2: claim
await registry.claim("github", "org/repo", proof)

// Step 3: withdraw accumulated funds
await escrow.withdraw(tokenAddress)
```

---

## Trust Model

The registry contract has no privileged operators beyond the admin key, whose only authority is registering and replacing verifier contracts via `setVerifier`. The trust assumptions are entirely in the verifiers.

### Oracle verifiers (current reference implementation)

A trusted backend confirms ownership off-chain and issues a signed proof. The trust model is equivalent to trusting that backend service.

Mitigations:

- The signing key is rotatable via `setTrustedSigner` without changing the registry or invalidating existing claims.
- A compromised key allows claiming any unclaimed identifier in affected namespaces, until the key is rotated.
- Signing keys should be held in an HSM with defined rotation procedures.

### ZK verifiers (migration path)

Ownership is proven cryptographically on-chain. No trust assumption beyond the proof system itself.

- **GitHub:** zkTLS proof of the GitHub API response (vlayer, TLSNotary).
- **DNS:** DNSSEC proof — ENS's `DNSSECImpl` can be wrapped directly as an `IVerifier`.

The migration path is: deploy a new `IVerifier` implementation and call `registry.setVerifier(namespace, newVerifier)`. Existing claims are unaffected. The interface is designed to accommodate this migration with no changes to the registry.

---

## Security Considerations

**Proof replay.** EIP-712 domain separation binds proofs to a specific chain and registry deployment. Proofs include a claimant address and an expiry timestamp (default 1 hour). Within the TTL window, the same proof could be re-submitted by the same claimant after a revoke. This is accepted at the contract level and mitigated by the backend issuing fresh proofs on each request.

**Identifier collisions.** `abi.encode` (length-prefixed) prevents collisions between different namespace/string pairs that produce the same packed concatenation.

**Normalisation.** Rules are namespace-specific and enforced by verifiers, not globally by the registry. Frontends and verifiers share responsibility for consistent canonicalisation.

**Oracle key compromise.** A compromised signing key allows claiming any unclaimed identifier in all namespaces sharing that verifier, until the key is rotated. Key storage and rotation procedures are required for production deployments.

**Escrow upgradeability.** The beacon is owned by the `EscrowFactory`. Upgrading the escrow implementation simultaneously affects the logic behind all deployed proxies. The factory admin key is a critical trust assumption for the pre-funding module, independent of the registry admin key.

**Counterfactual address griefing.** Deposit addresses are public and computable by anyone. An adversary could pre-deploy escrow proxies for identifiers at a gas cost, without any effect on correctness — the deposit address and accumulated funds are unaffected. This is a nuisance, not a security issue.

**No registrant transfer.** There is no function to transfer a registered identifier to another address. Changing the registrant requires revoking and re-claiming with a new proof. This ties the registered address to current proven ownership, but means wallet rotation requires a new verification round-trip.

**Identifier renames.** Off-chain identifiers can change their canonical string — a GitHub repository can be renamed, a package can be moved to a new scope. When this happens, the old `bytes32` hash and the new one are unrelated. The old identifier still resolves to the original owner; the new identifier resolves to `address(0)`. The recommended migration is: (1) claim the new identifier (the owner still controls the entity), (2) link the old identifier as an alias of the new one via `linkIds`. After linking, both identifiers resolve correctly. If the owner does not act, the old claim becomes stale. Verifier implementations that enforce time-bounded claims mitigate this — the stale claim expires when the owner can no longer produce a valid renewal proof. See the FAQ in the documentation site for worked examples.

---

## Relationship to Existing Projects

**ENS.** Maps human-readable names to addresses. The Entity Registry maps entity identifiers to addresses. The two are complementary — an ENS name can resolve to a registry deposit address. For DNS domains, the ENS `DNSSECImpl` is the natural upgrade path for the oracle-based DNS verifier.

**EAS.** The natural long-term storage layer for ownership attestations. The current registry maintains an internal mapping for self-containment. A future design could use EAS attestations as the canonical source of truth, inheriting EAS's revocation model, indexing, and composability. The conditions for that migration — EAS schema stability, gas cost, upgrade path — are an open research question.

**Splits.** Every deposit address is a first-class Splits Warehouse recipient. The `ClaimableEscrow` handles both Warehouse deposits (via `batchDeposit`) and direct ERC-20 transfers in a single `withdraw` call. Distribution protocols that route funds through the Splits Warehouse can use any deposit address as an allocation recipient without modification.

**Drips.** Maps GitHub repositories to addresses with pre-funding support, using an oracle to read `FUNDING.json`. The Entity Registry generalises the same pattern across namespaces with a pluggable verifier interface, a defined path toward trustless verification, and a design as a shared primitive rather than application-specific infrastructure.

---

## Open Questions

The current implementation settles the core architecture. These questions remain open:

1. **Identifier canonicalisation standard.** What is the minimal, collision-safe, stable scheme for namespacing off-chain identifiers on Ethereum? How should it handle Unicode, case sensitivity, redirects, and identifier expiry across different namespace types?

2. **Verification trust spectrum.** What is the right interface boundary between the registry and verifiers to allow a smooth migration from oracle-based to ZK-based proofs? What security properties should the interface guarantee, and what constraints does it place on verifier implementations?

3. **EAS integration path.** What are the exact conditions — schema stability, gas cost model, revocation compatibility — under which migrating the internal `owners` mapping to EAS attestations is appropriate?

4. **Namespace governance.** Who can register a new namespace (`npm:`, `crates:`, `pypi:`)? What prevents namespace squatting while keeping the system permissionless for verifier authors?

5. **Identifier permanence and challenges.** GitHub repositories can be renamed or transferred, domains can expire, handles can be sold. What is the correct on-chain model for expiring or challenging stale claims without introducing a governance attack surface? The current mitigation — claim the new identifier and link the old one as an alias — works when the owner acts proactively. For cases where the owner does not act (or a different entity now controls the old identifier), the open questions are: should claims expire automatically, and should third parties be able to challenge stale claims with a counter-proof (oracle-signed or ZK)?

6. **Standardisation path.** What is the right venue and format for standardising the identifier scheme and registry interface — an informational EIP, an ERC, an Ethereum Magicians thread?

---

## Status

This is a research prototype. The reference implementation includes the registry contract, oracle-based verifiers for GitHub and DNS, the pre-funding module (`EscrowFactory` and `ClaimableEscrow`), a TypeScript SDK, and backend signing services. It has not been audited and is not production-ready.

Feedback and contributions are welcome. The primary goal at this stage is to validate the identifier scheme, the verifier interface, and the counterfactual address property as a shared primitive before pursuing standardisation.
