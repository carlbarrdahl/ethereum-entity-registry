# Privacy-Preserving Email Identity via ERC-8185/8186

Gasless, email-first onboarding with zero plaintext on-chain — inspired by [Privy](https://docs.privy.io/wallets/overview), built on open standards.

For the broader architecture review of this as open Privy-like infrastructure, see [Open Privy Infrastructure Review](./open-privy-infrastructure-review.md).

## Problem

Privy delivers excellent wallet UX: enter an email, get a funded wallet, no extensions, no seed phrases. But it's a proprietary service — your users' wallets, keys, and auth are coupled to one vendor.

ERC-8185 (Off-Chain Entity Registry) and ERC-8186 (Identity Account) already have the protocol primitives to match this UX. The gap is that the current `claim()` function puts plaintext identifiers on-chain:

```solidity
// Current: email visible in calldata and events
function claim(string calldata namespace, string calldata canonicalString, bytes calldata proof) external;
emit Claimed(id, namespace, canonicalString, owner);
```

For emails and other personal identifiers this is unacceptable.

## Key Insight

The `bytes32 id` is already a one-way hash:

```
id = keccak256(abi.encode("email", "alice@example.com"))
```

Everything downstream — `ownerOf(id)`, `predictAddress(id)`, `linkIds`, `execute` — operates on opaque `bytes32` values. The `OracleVerifier` signs over `(id, claimant, expiry)`, not the plaintext. The only reason the email touches the chain today is that `claim()` computes the hash on-chain from its string inputs.

Move the hash computation off-chain, and the email never needs to exist on-chain at all.

## Design

### Claim by id

Add a `claimById` path that accepts a pre-computed `bytes32 id` directly, paired with a `bytes32 namespaceKey` for verifier routing:

```solidity
function claimById(bytes32 namespaceKey, bytes32 id, bytes calldata proof) external;
```

The `namespaceKey` is `keccak256("email")` — it reveals the *type* of identity (email vs. github) but not the value. The `id` is the full `keccak256(abi.encode(namespace, canonicalString))` hash, pre-computed by the client. Neither the namespace string nor the canonical string appear on-chain.

The corresponding event emits only opaque values:

```solidity
event ClaimedById(bytes32 indexed namespaceKey, bytes32 indexed id, address indexed owner);
```

### What changes, what doesn't

| Component | Change needed |
|---|---|
| `IOffChainEntityRegistry` | Add `claimById(bytes32, bytes32, bytes)` and `revokeById(bytes32)` |
| `IVerifier` | None — already operates on `bytes32 id` |
| `OracleVerifier` | None — proof is `(id, claimant, expiry)` signature |
| `AccountFactory` | None — `predictAddress(id)` and `deployAccount(id)` already use `bytes32` |
| `IdentityAccount` | None — `execute()` checks `ownerOf(id)`, all `bytes32` |
| Linking | None — `linkIds` / `unlinkIds` already use `bytes32` |
| Indexer | Index `ClaimedById` events alongside `Claimed` |

The existing `claim(namespace, canonicalString, proof)` path remains for public identifiers (GitHub repos, DNS domains) where on-chain discoverability matters. `claimById` is the privacy-preserving alternative for personal identifiers.

### Brute-force resistance

Common emails (`john@gmail.com`) could be guessed and hashed to match on-chain ids. Two mitigations:

**Option A — Salted hash.** Include a per-identifier salt in the hash:

```
id = keccak256(abi.encode("email", "alice@example.com", salt))
```

The oracle generates the salt when the user first registers intent and includes it in the signed proof. The sender obtains the salt from an API or the oracle to compute the deposit address. On-chain, the salted hash is unguessable. The salt is not secret — it's shared with authorized senders — but it prevents passive observers from brute-forcing the id from a list of known emails.

**Option B — No salt, accept the trade-off.** If the threat model only covers passive observers (not targeted attackers who already know the email and are watching for its hash), the unsalted hash may be sufficient. The id reveals nothing to someone who doesn't already know the email.

This document assumes Option B (unsalted) for simplicity. Option A is a drop-in upgrade — the contract doesn't change, only the off-chain hash computation.

## Implementation

### 1. Registry: add `claimById` and `revokeById`

```solidity
function claimById(bytes32 namespaceKey, bytes32 id, bytes calldata proof) external {
    require(ownerOf(id) == address(0), "already claimed");

    address verifier = verifiers[namespaceKey];
    require(verifier != address(0), "no verifier");
    require(IVerifier(verifier).verify(id, msg.sender, proof), "invalid proof");

    if (aliases[id] != bytes32(0)) {
        delete aliases[id];
    }

    owners[id] = msg.sender;
    emit ClaimedById(namespaceKey, id, msg.sender);
}

function revokeById(bytes32 id) external {
    require(aliases[id] == bytes32(0), "cannot revoke alias");
    require(owners[id] == msg.sender, "not owner");

    address previous = owners[id];
    delete owners[id];
    emit RevokedById(id, previous);
}
```

This is nearly identical to the existing `claim` — it just skips the on-chain `toId()` computation and the plaintext event fields.

### 2. Email verifier (oracle-based)

Reuse the existing `OracleVerifier` — it already signs over `(id, claimant, expiry)` and never sees the plaintext on-chain. The oracle backend adds an email verification step:

```
POST /api/proof/email
  Body: { email: "alice@example.com", claimant: "0xAlice..." }
  
  1. Send OTP / magic link to alice@example.com
  2. User verifies
  3. Compute: id = keccak256(abi.encode("email", normalize(email)))
  4. Sign EIP-712: { id, claimant, expiry }
  5. Return: { id, proof: abi.encode(signature, expiry) }
```

The existing `OracleVerifier` contract works unchanged — register it under `keccak256("email")` namespace key.

### 3. Gasless relayer

A thin relay service that submits transactions on behalf of users so they never need ETH or a wallet extension to claim.

```
POST /api/relay
  Body: { namespaceKey, id, proof, claimant }
  
  1. Validate the proof off-chain (optional, saves gas on revert)
  2. Call registry.claimById(namespaceKey, id, proof) from the relayer EOA
  3. Call factory.deployAccount(id) if not already deployed
  4. Return: { txHash, accountAddress }
```

The `claim()` function records `msg.sender` as the owner. Since the relayer is `msg.sender`, we need one adjustment: the oracle proof should bind to the *intended owner*, and the registry should accept an explicit `owner` parameter:

```solidity
function claimByIdFor(
    bytes32 namespaceKey,
    bytes32 id,
    address owner,
    bytes calldata proof
) external {
    require(ownerOf(id) == address(0), "already claimed");

    address verifier = verifiers[namespaceKey];
    require(verifier != address(0), "no verifier");
    // Verifier checks that the proof authorizes `owner`, not msg.sender
    require(IVerifier(verifier).verify(id, owner, proof), "invalid proof");

    if (aliases[id] != bytes32(0)) {
        delete aliases[id];
    }

    owners[id] = owner;
    emit ClaimedById(namespaceKey, id, owner);
}
```

This way anyone (relayer, bundler, friend) can submit the claim on behalf of the rightful owner, as long as the proof is valid for that owner address.

### 4. Embedded signer (the owner address)

The user still needs an Ethereum address to be the `owner`. Without requiring MetaMask or any extension, options:

| Approach | How it works | Trade-offs |
|---|---|---|
| **Passkeys (WebAuthn)** | Browser generates a P-256 keypair tied to the device + biometrics. Derive an Ethereum address from the public key, or use an ERC-4337 account with a passkey verifier. | Best UX (biometric), no seed phrase, device-bound. Needs a smart account wrapper for non-secp256k1 curve. |
| **Privy/Turnkey as signer only** | Use Privy (or Turnkey, Lit, etc.) purely for key management. The embedded signer provides the owner address. Your protocol handles identity and accounts. | Simple integration, Privy handles key security. Vendor dependency is limited to signer layer only. |
| **In-browser EOA** | Generate a random keypair in the browser, encrypt with a password or passkey, store in localStorage or iCloud keychain. | Simplest, but weakest key management. |
| **Backend custodial** | Backend holds the key, user authenticates via email. | Centralized custody — antithetical to the protocol's goals. |

**Recommended: Passkeys.** They give Privy-level UX (biometric auth, no seed phrases) without any vendor dependency. The passkey-derived address becomes the `owner` in the registry. If the user later wants to migrate to a hardware wallet, they claim a new identifier and link it, or the identity account itself can be an ERC-4337 account with owner rotation.

### 5. "Send to email" flow

The sender-side flow that makes this useful:

```
Sender UI:
  1. Enter "alice@example.com"
  2. Client computes:
       id = keccak256(abi.encode("email", normalize("alice@example.com")))
       address = factory.predictAddress(id)
  3. Display: "Send to 0x7a3f...  (alice@example.com's identity account)"
  4. Sender transfers ETH/ERC-20 to that address
  5. Optionally: call setReclaim(senderAddress, deadline) for fund recovery

Recipient:
  6. Notified via email (by the sender's platform, or a shared notification service)
  7. Verifies email → claim → controls the account
```

The sender needs no API calls to compute the address — it's a pure client-side hash + CREATE2 prediction. The address is deterministic and identical across all platforms using the same factory deployment.

## Full User Flow

```
                    Off-chain                                 On-chain
                    ─────────                                 ────────

  ┌─ SEND ──────────────────────────────────────────────────────────────────┐
  │                                                                         │
  │  Sender types: alice@example.com                                        │
  │  Client computes:                                                       │
  │    id = keccak256(abi.encode("email", "alice@example.com"))             │
  │    addr = factory.predictAddress(id)          ──►  addr is deterministic│
  │  Sender transfers tokens to addr              ──►  funds land at addr   │
  │  (optional) setReclaim(sender, deadline)      ──►  reclaim configured   │
  │                                                                         │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─ CLAIM ─────────────────────────────────────────────────────────────────┐
  │                                                                         │
  │  Alice opens link, enters email                                         │
  │  App creates passkey (biometric)  ──►  owner = passkey-derived address  │
  │  Backend sends OTP to alice@example.com                                 │
  │  Alice enters OTP                                                       │
  │  Backend signs proof: (id, owner, expiry)                               │
  │  Relayer submits:                                                       │
  │    registry.claimByIdFor(                     ──►  owners[id] = owner   │
  │      namespaceKey, id, owner, proof)               ClaimedById(…, owner)│
  │    factory.deployAccount(id)                  ──►  account deployed     │
  │                                                                         │
  │  Alice now controls her identity account                                │
  │  via passkey — no extension, no seed phrase,                            │
  │  no email on-chain                                                      │
  │                                                                         │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─ USE ───────────────────────────────────────────────────────────────────┐
  │                                                                         │
  │  Alice signs with passkey  ──►  account.execute(target, data, value)    │
  │  Transfer tokens, interact with DeFi, claim airdrops — anything        │
  │                                                                         │
  │  Later: link GitHub, DNS, other identities                              │
  │  Later: migrate owner to hardware wallet                                │
  │                                                                         │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─ RECLAIM (if unclaimed) ────────────────────────────────────────────────┐
  │                                                                         │
  │  Deadline passes, Alice never claimed                                   │
  │  Sender calls account.execute(…)              ──►  funds returned       │
  │  via reclaimTo authorization                                            │
  │                                                                         │
  └─────────────────────────────────────────────────────────────────────────┘
```

## What Lands On-chain

| Data | Visible? |
|---|---|
| `bytes32 id` (hash of namespace + email) | Yes — opaque, irreversible without knowing the email |
| `bytes32 namespaceKey` (`keccak256("email")`) | Yes — reveals this is an email-type claim, not the email itself |
| `address owner` | Yes — the passkey-derived address |
| Email address | **Never** |
| OTP / magic link | **Never** |
| Oracle signature | Yes — in calldata, but reveals nothing beyond `(id, owner, expiry)` |

## Comparison with Privy

| | Privy | ERC-8185/8186 + this design |
|---|---|---|
| Email sign-in | Yes | Yes (OTP + oracle verifier) |
| Pregenerated wallets | Yes (server-side) | Yes (deterministic CREATE2, client-computable) |
| No seed phrase | Yes (TEE key splitting) | Yes (passkeys / biometric) |
| Gasless onboarding | Yes | Yes (relayer) |
| Email on-chain | N/A (no blockchain identity) | **Never** — hash only |
| Vendor lock-in | Yes | **No** — open protocol, any frontend |
| Fund reclaim | No | **Yes** — protocol-native |
| Identity linking | No | **Yes** — email + github + dns under one primary |
| Canonical addresses | No (Privy-specific) | **Yes** — same address for same email across all apps |
| Self-custody | Shared (TEE) | **Full** — owner holds the key |
| Progressive decentralization | No | **Yes** — start with email, upgrade to hardware wallet |

## Implementation Checklist

1. **Registry**: Add `claimById`, `claimByIdFor`, `revokeById` to `IOffChainEntityRegistry` alongside existing `claim`/`revoke`
2. **Email namespace**: Register `OracleVerifier` under `keccak256("email")` namespace key — no new contract needed
3. **Email oracle endpoint**: `POST /api/proof/email` — send OTP, verify, sign EIP-712 proof over `(id, owner, expiry)`
4. **Relayer endpoint**: `POST /api/relay` — submit `claimByIdFor` + `deployAccount` in one gasless transaction
5. **Passkey signer**: Generate passkey on first visit, derive owner address (or use ERC-4337 with P-256 verifier)
6. **Frontend**: "Enter your email" as the primary entry point instead of "Connect Wallet"
7. **"Send to email" UI**: Client-side `toId` + `predictAddress` for deposit address computation
8. **Indexer**: Index `ClaimedById` events, store email→id mapping in off-chain database (encrypted, access-controlled)

## Open Questions

- **Namespace key privacy**: `keccak256("email")` reveals the claim type. Is this acceptable? If not, the verifier could be a universal verifier that handles all private namespaces, and no namespace key is emitted.
- **Salt coordination**: If salted hashes are used, how does a sender learn the salt for a recipient they haven't interacted with before? An oracle API (`GET /api/salt?email=...` after authentication) is one option, but adds a round-trip.
- **Passkey recovery**: Device loss means key loss. Options: iCloud/Google passkey sync, social recovery via linked identities, or a recovery guardian.
- **Notification**: Who tells Alice she has funds waiting? The protocol doesn't send emails. A shared notification service or the sending platform handles this off-chain.
