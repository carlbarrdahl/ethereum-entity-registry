# Ethereum Magicians Discussion Post — ERC-8186

> **Title**: ERC-8186: Identity Account
>
> **Category**: ERCs
>
> **Tags**: identity, account, funding, off-chain, agents, CREATE2

---

## ERC-8186: Identity Account

A companion to [ERC-8185: Off-Chain Entity Registry](https://ethereum-magicians.org/t/erc-8185-off-chain-entity-registry-erc-8186-claimable-escrow/27899).

ERC-8185 maps off-chain identifiers to Ethereum addresses, but only after the entity has registered. The most compelling use cases require sending value *before* the entity has engaged with Ethereum — an address that exists before the entity does.

ERC-8186 defines deterministic smart accounts for identifiers. Under a given factory, the address is a pure function of the identifier (CREATE2), computable locally. Funds accumulate at the address. Once the entity claims their identifier, the registered owner controls the account.

### Design

- **One function**: `execute(target, data, value)`. The registered owner can make any call through the account — withdraw tokens, interact with DeFi, claim airdrops, or anything else. No hardcoded `withdraw`.
- **Strict base authorization**: The base interface allows only the registered owner. No unconstrained MAY clause for additional callers.
- **Explicit reclaim extension**: Fund recovery is defined as `IReclaimableIdentityAccount` — a named optional interface, not an open-ended authorization hook. If an account implements it, a configured `reclaimTo` address can call `execute` after a deadline while the identity is unclaimed.
- **Stable addresses**: Proxy addresses don't change on implementation upgrade. A beacon proxy pattern satisfies this.
- **Factory selection is a deployment concern**: The same identifier yields different addresses under different factories. This ERC defines the derivation rule, not a canonical factory. Ecosystems that want one canonical deposit address per identifier should coordinate on a canonical factory per chain.

### What happens when an identifier changes?

Off-chain identifiers aren't permanent — repositories get renamed, domains expire, packages get unpublished. When this happens, the old and new `bytes32` hashes are unrelated: the old identifier still resolves to the original owner, the new one resolves to `address(0)`.

The owner should claim the new identifier via ERC-8185 and link the old one as an alias — both then resolve to the same address. Funds already at the old account address remain accessible. Verifier implementations can also enforce time-bounded claims requiring periodic re-verification, causing stale claims to expire naturally.

### Unclaimed fund recovery

If no one ever claims an identifier, funds sitting at the account address would be stuck forever in the base model. The optional `IReclaimableIdentityAccount` extension solves this: the funder (or platform) configures a `reclaimTo` address and a deadline via `setReclaim`. After the deadline passes — and only while the identity remains unclaimed — `reclaimTo` can call `execute` to recover funds. Once the identity is claimed, the reclaim path is disabled and the registered owner has full control.

This is an explicit opt-in extension, not part of the base `IIdentityAccount` interface, so accounts that don't need reclaim stay minimal.

### Reference

- Minimal reference contracts: `assets/erc-8186/` in the ERC
- Full implementation (not audited): [ethereum-entity-registry](https://github.com/carlbarrdahl/ethereum-entity-registry)

Feedback welcome — particularly on the base-vs-extension split for reclaim, the factory canonicalization question, and whether reentrancy guards should be REQUIRED vs RECOMMENDED.
