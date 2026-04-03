# Entity Registry

**A shared on-chain primitive for addressing off-chain entities on Ethereum.**

---

## The Problem

Ethereum has a standard way to address humans (ENS) but no standard way to address off-chain entities. A grants protocol that wants to fund a GitHub repository, a DAO that wants to pay a domain, or a dependency tool that wants to route contributions to every package in a supply chain all face the same problem: the recipient has no Ethereum address.

Today each protocol solves this independently — Drips built a GitHub-to-address registry with an oracle, Gitcoin maintains its own project registry. Any new protocol that needs to address off-chain entities either builds another bespoke system or depends on someone else's.

The Entity Registry is a shared primitive so they don't have to.

---

## What It Does

The registry maps `(namespace, string)` pairs to Ethereum addresses:

```
github:org/repo      → 0xAlice
dns:example.com      → 0xBob
npm:package-name     → (unclaimed)
```

Two properties make it useful beyond a naming service:

1. **Counterfactual addressing.** Every identifier has a deterministic deposit address before anyone has registered. A protocol can fund `github:org/repo` immediately — the maintainers claim the funds whenever they're ready.

2. **Pluggable verification.** Ownership is proven through per-namespace verifier contracts. The interface supports oracle-signed proofs today and ZK-based proofs tomorrow, with no changes to the registry.

---

## How It Works

```
Funder → token.transfer(depositAddress, amount)
         ...time passes...
Entity → registry.claim("github", "org/repo", proof)
Entity → escrow.withdraw(token)
```

The deposit address is stable: it does not change if ownership changes or the escrow implementation is upgraded.

### Architecture

The system is two independent layers:

**EntityRegistry** — pure identity. Maps identifiers to addresses. No funds, no escrow, no opinions about how money flows. One deployment per chain.

**EscrowFactory + ClaimableEscrow** — optional pre-funding module. Deploys a proxy per identifier at the deterministic deposit address. Holds accumulated funds and releases them to the registrant on claim. Supports both direct ERC-20 transfers and Splits Warehouse deposits.

The registry does not depend on the escrow module. Protocols that only need identity resolution — "who owns this identifier?" — interact with the registry alone:

```solidity
interface IEntityRegistry {
    function ownerOf(bytes32 id) external view returns (address);
}
```

### Verification

The registry delegates proof verification to a per-namespace `IVerifier` contract:

```solidity
interface IVerifier {
    function verify(bytes32 id, address claimant, bytes calldata proof) external returns (bool);
}
```

Current reference verifiers use an oracle model: a backend confirms ownership (GitHub OAuth, DNS TXT record) and signs an EIP-712 proof. Oracle verifiers can be replaced with ZK-based verifiers (vlayer, TLSNotary, DNSSEC) as that tooling matures — existing claims are unaffected.

### Linking

An entity that controls multiple identifiers (a GitHub repo and a DNS domain) can link them after claiming both:

```
registry.linkIds(primaryId, [aliasId1, aliasId2])
```

Linked aliases resolve to the primary's registrant transparently through `ownerOf`. Each identifier's escrow remains separate, but all withdraw to the same address.

### Identifier Renames

Off-chain identifiers can change — a GitHub repo can be renamed, a package can move to a new scope. When this happens, the old and new `bytes32` hashes are unrelated: the old identifier still resolves to the original owner; the new one resolves to `address(0)`.

The recommended migration is claim-and-link: (1) claim the new identifier — the owner still controls the entity, so any verifier (oracle or ZK) approves the proof; (2) link the old identifier as an alias of the new one. After linking, both identifiers resolve to the same address and protocols that cached the old identifier continue to work.

If the owner does not act, the old claim becomes stale. Time-bounded claims (where verifiers require periodic re-verification) let stale claims expire naturally. A more active challenge mechanism is an open research question.

---

## Why Not Use Existing Projects?

### vs. ENS

ENS maps human-readable names to addresses. The Entity Registry maps entity identifiers (repos, domains, packages) to addresses.

|                    | ENS                                | Entity Registry                          |
| ------------------ | ---------------------------------- | ------------------------------------------- |
| Subject            | Humans and organisations           | Off-chain entities (repos, domains, packages) |
| Registration model | Proactive — entity must register first | Counterfactual — address exists before registration |
| Pre-funding        | Not supported                      | Funds can be sent to any identifier immediately |

The two are complementary. An ENS name can resolve to a registry deposit address. For DNS domains, the ENS `DNSSECImpl` contract is the natural upgrade path for the oracle-based DNS verifier.

### vs. Drips

Drips maps GitHub repositories to addresses with pre-funding support, using an oracle to read `FUNDING.json`.

|                       | Drips                              | Entity Registry                              |
| --------------------- | ---------------------------------- | ----------------------------------------------- |
| Scope                 | GitHub repositories                | Any namespace (GitHub, DNS, npm, etc.)          |
| Verification          | Application-specific oracle        | Pluggable `IVerifier` — oracle now, ZK later    |
| Design                | Integrated into the Drips protocol | Standalone primitive — any protocol can read it |

Drips could use the Entity Registry as its identity layer instead of maintaining a separate resolution system.

### vs. EAS

EAS provides attestation infrastructure — schemas, revocation, indexing — but no claiming mechanism or identifier standard for off-chain entities. A future registry design could use EAS attestations as the canonical storage layer, inheriting EAS's revocation model and indexing. The conditions for that migration are an open research question.

---

## Trust Model

The registry contract has no privileged operators beyond verifier governance (`setVerifier`). It holds no funds.

**Oracle verifiers** (current): trust the backend signing service. A compromised key allows claiming unclaimed identifiers until rotated. The key is rotatable without affecting existing claims.

**ZK verifiers** (migration path): ownership is proven cryptographically on-chain. No trust assumption beyond the proof system. Deploy a new `IVerifier` and call `setVerifier` — no other contract changes needed.

The escrow module has its own trust surface: the `EscrowFactory` admin can upgrade the escrow implementation for all proxies via the beacon. This is independent of the registry admin.

---

## Integration

**On-chain consumer.** Import `IEntityRegistry`. Call `ownerOf(id)`. Route funds to the returned address if claimed, or to the deposit address if not.

**Distribution protocol.** Resolve identifiers to addresses at allocation creation time. Store plain Ethereum addresses. No registry interaction at distribution time.

**Registrant.** Obtain a proof from the signing service, call `claim`, then `withdraw` to sweep accumulated funds.

See the [documentation site](./apps/docs/) for detailed integration patterns, security model, and SDK reference.

---

## Status

Research prototype. The reference implementation includes the registry contract, oracle verifiers for GitHub and DNS, the pre-funding module, a TypeScript SDK, and backend signing services. Not audited.

See [spec.md](./spec.md) for the full research paper including design trade-offs, security considerations, and open questions.
