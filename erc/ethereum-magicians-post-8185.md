# Ethereum Magicians Discussion Post — ERC-8185

> **Title**: ERC-8185: Off-Chain Entity Registry
>
> **Category**: ERCs
>
> **Tags**: identity, registry, agents, off-chain

---

## ERC-8185: Off-Chain Entity Registry

Protocols and AI agents need to resolve off-chain identifiers — GitHub repos, DNS domains, npm packages — to Ethereum addresses. No standard for this exists. Each protocol builds its own resolution system.

ERC-8185 defines a shared registry that maps `(namespace, canonicalString)` pairs to Ethereum addresses. Identifiers are hashed to `bytes32`. Ownership is proven through per-namespace verifier contracts, enabling a migration path from oracle-signed proofs to ZK verification without changes to the registry. The registry holds no funds and charges no fees.

### Design

- **Identifier scheme**: `keccak256(abi.encode(namespace, canonicalString))`. Namespace labels are constrained to lowercase ASCII (`[a-z0-9-]+`). Canonical string normalization is namespace-specific and enforced by verifiers and frontends, not the contract.
- **Pluggable verification**: `IVerifier` has one function — `verify(id, claimant, proof) → bool`. Oracle-signed proofs today, zkTLS/DNSSEC tomorrow, no registry changes.
- **No transfer function**: Changing a registrant requires revoke + re-claim with a new proof. Ownership is always tied to verified control at claim time.
- **Single-level aliases**: Multiple identifiers controlled by the same entity (e.g. a GitHub repo and a DNS domain) can be linked with O(1) resolution.

### Companion ERC

[ERC-8186: Identity Account](https://ethereum-magicians.org/t/erc-8185-off-chain-entity-registry-erc-8186-claimable-escrow/27899) defines deterministic smart accounts (CREATE2) for every identifier. The base interface is a single `execute(target, data, value)` function — the registered owner can make any call through the account. Fund reclaim is defined as an explicit optional extension (`IReclaimableIdentityAccount`) rather than baked into the base interface. ERC-8186 depends on ERC-8185 for ownership resolution but is architecturally independent.

### Reference

- Minimal reference contracts: `assets/erc-8185/` in the ERC
- Full implementation (not audited): [ethereum-entity-registry](https://github.com/carlbarrdahl/ethereum-entity-registry)

Feedback welcome — particularly on the namespace label constraints, the verifier interface, and any overlapping ERCs I've missed.
