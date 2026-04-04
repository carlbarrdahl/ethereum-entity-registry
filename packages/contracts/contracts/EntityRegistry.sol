// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {IVerifier} from "./IVerifier.sol";
import {IEntityRegistry} from "./IEntityRegistry.sol";
import {IdentityAccount} from "./IdentityAccount.sol";

/// @title  EntityRegistry
/// @notice Maps off-chain identifiers (GitHub repos, DNS domains) to Ethereum addresses.
///
/// @dev    This contract handles ownership claims only — it holds no funds.
///         Each identifier has a deterministic Ethereum address (via CREATE2).
///         The account implementation behind the beacon determines how the
///         identity account behaves.
///
///         Identifier format:
///           bytes32 id = keccak256(abi.encode(namespace, canonicalString))
///           e.g. keccak256(abi.encode("github", "org/repo"))
///                keccak256(abi.encode("dns",    "example.com"))
///
///         Namespace labels must match [a-z0-9-]+ and are interpreted as
///         lowercase ASCII. Canonicalization rules for canonicalString are
///         namespace-specific and enforced off-chain by verifiers and frontends,
///         not by this contract.
contract EntityRegistry is IEntityRegistry, Ownable {

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    UpgradeableBeacon public immutable beacon;

    /// @notice keccak256(bytes(namespace)) => verifier contract address
    mapping(bytes32 => address) public verifiers;

    /// @notice identifier => registered owner address (zero = unclaimed or is an alias)
    mapping(bytes32 => address) public owners;

    /// @notice identifier => canonical identifier (zero = not an alias)
    ///         Aliases are set via linkIds(). Only one level of indirection is allowed.
    mapping(bytes32 => bytes32) public aliases;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event Claimed(bytes32 indexed id, string namespace, string canonicalString, address indexed owner);
    event Revoked(bytes32 indexed id, string namespace, string canonicalString, address indexed previousOwner);
    event Linked(bytes32 indexed aliasId, bytes32 indexed primaryId);
    event Unlinked(bytes32 indexed aliasId, bytes32 indexed primaryId);
    event AccountDeployed(bytes32 indexed id, address account);
    event VerifierUpdated(bytes32 indexed namespaceKey, string namespace, address verifier);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address accountImpl_, address admin) Ownable(admin) {
        beacon = new UpgradeableBeacon(accountImpl_, address(this));
    }

    // -------------------------------------------------------------------------
    // Identifier helpers
    // -------------------------------------------------------------------------

    /// @notice Computes the canonical identifier for a (namespace, canonicalString) pair.
    /// @dev    Uses abi.encode (length-prefixed) instead of abi.encodePacked to prevent
    ///         collisions between different namespace/string pairs that share a common
    ///         concatenation (e.g. "githu" + "borg/repo" vs "github" + "org/repo").
    function toId(string calldata namespace, string calldata canonicalString) public pure returns (bytes32) {
        _requireValidNamespace(namespace);
        return keccak256(abi.encode(namespace, canonicalString));
    }

    /// @notice Resolves an identifier to its canonical form, following one alias hop if present.
    function canonicalOf(bytes32 id) public view returns (bytes32) {
        bytes32 primary = aliases[id];
        return primary == bytes32(0) ? id : primary;
    }

    /// @notice Returns the owner of `id`, resolving through any alias.
    function ownerOf(bytes32 id) public view returns (address) {
        return owners[canonicalOf(id)];
    }

    // -------------------------------------------------------------------------
    // CREATE2 account helpers (BeaconProxy)
    // -------------------------------------------------------------------------

    /// @dev Builds the BeaconProxy constructor args for a given identifier.
    function _accountInitData(bytes32 id) internal view returns (bytes memory) {
        return abi.encodeCall(IdentityAccount.initialize, (address(this), id));
    }

    /// @notice Returns the deterministic address for the IdentityAccount proxy of `id`.
    ///         This address is stable and can be computed by any frontend before
    ///         the account is deployed, so funders can transfer tokens directly to it.
    ///         The address does NOT change if the account implementation is upgraded
    ///         via the beacon — only the proxy bytecode and constructor args matter.
    function predictAddress(bytes32 id) public view returns (address) {
        bytes32 initcodeHash = keccak256(abi.encodePacked(
            type(BeaconProxy).creationCode,
            abi.encode(address(beacon), _accountInitData(id))
        ));
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            id,
            initcodeHash
        )))));
    }

    /// @notice Deploys the IdentityAccount proxy for `id` if it has not been deployed yet.
    ///         Anyone may call this. The account is not required to exist for funding;
    ///         it only needs to be deployed before the owner interacts with it.
    function deployAccount(bytes32 id) public returns (address account) {
        require(predictAddress(id).code.length == 0, "EntityRegistry: account already deployed");
        account = address(new BeaconProxy{salt: id}(address(beacon), _accountInitData(id)));
        emit AccountDeployed(id, account);
    }

    // -------------------------------------------------------------------------
    // Claims
    // -------------------------------------------------------------------------

    /// @notice Claim ownership of an identifier by submitting a valid proof.
    ///         Deploys the IdentityAccount if not yet deployed.
    function claim(
        string calldata namespace,
        string calldata canonicalString,
        bytes calldata proof
    ) external {
        bytes32 id = toId(namespace, canonicalString);
        require(ownerOf(id) == address(0), "EntityRegistry: already claimed");

        address verifier = verifiers[keccak256(bytes(namespace))];
        require(verifier != address(0), "EntityRegistry: no verifier for namespace");
        require(IVerifier(verifier).verify(id, msg.sender, proof), "EntityRegistry: invalid proof");

        if (aliases[id] != bytes32(0)) {
            delete aliases[id];
        }

        owners[id] = msg.sender;
        emit Claimed(id, namespace, canonicalString, msg.sender);

        if (predictAddress(id).code.length == 0) {
            deployAccount(id);
        }
    }

    // -------------------------------------------------------------------------
    // Linking
    // -------------------------------------------------------------------------

    /// @notice Link one or more aliases to `primaryId` so all resolve to the same owner.
    ///         All identifiers must already be claimed by msg.sender.
    ///         `primaryId` must not itself be an alias (no chaining).
    ///         All-or-nothing: any invalid alias reverts the entire transaction.
    ///         Funds in each identifier's account remain separate; all controlled by the same owner.
    function linkIds(bytes32 primaryId, bytes32[] calldata aliasIds) external {
        require(owners[primaryId] == msg.sender, "EntityRegistry: not owner of primary");
        require(aliases[primaryId] == bytes32(0), "EntityRegistry: primary is itself an alias");

        for (uint256 i = 0; i < aliasIds.length; i++) {
            bytes32 aliasId = aliasIds[i];
            require(aliasId != primaryId, "EntityRegistry: cannot link to self");
            require(owners[aliasId] == msg.sender, "EntityRegistry: not owner of alias");
            require(aliases[aliasId] == bytes32(0), "EntityRegistry: alias already linked");

            aliases[aliasId] = primaryId;
            delete owners[aliasId];

            emit Linked(aliasId, primaryId);
        }
    }

    /// @notice Unlink one or more aliases from their primary, restoring each as an
    ///         independently owned identifier under msg.sender.
    ///         Only callable by the current owner of the primary.
    ///         All-or-nothing: any invalid alias reverts the entire transaction.
    function unlinkIds(bytes32 primaryId, bytes32[] calldata aliasIds) external {
        require(owners[primaryId] == msg.sender, "EntityRegistry: not owner of primary");

        for (uint256 i = 0; i < aliasIds.length; i++) {
            bytes32 aliasId = aliasIds[i];
            require(aliases[aliasId] == primaryId, "EntityRegistry: not an alias of this primary");

            delete aliases[aliasId];
            owners[aliasId] = msg.sender;

            emit Unlinked(aliasId, primaryId);
        }
    }

    // -------------------------------------------------------------------------
    // Revocation
    // -------------------------------------------------------------------------

    /// @notice Current owner voluntarily revokes their claim, returning the identifier
    ///         to unclaimed state. Funds remain at the same account address
    ///         and will be controllable by whoever claims the identifier next.
    ///         If `id` is a primary with aliases pointing to it, call unlinkIds() first
    ///         to restore independent ownership to those aliases. Any aliases not unlinked
    ///         before revocation become stale (resolve to address(0)) and are automatically
    ///         cleared the next time someone claims that alias identifier.
    function revoke(
        string calldata namespace,
        string calldata canonicalString
    ) external {
        bytes32 id = toId(namespace, canonicalString);
        require(aliases[id] == bytes32(0), "EntityRegistry: cannot revoke an alias");
        require(owners[id] == msg.sender, "EntityRegistry: not owner");
        address previous = owners[id];
        delete owners[id];
        emit Revoked(id, namespace, canonicalString, previous);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Register or replace the verifier contract for a namespace.
    ///         Existing claims under the previous verifier remain valid.
    function setVerifier(string calldata namespace, address verifier) external onlyOwner {
        _requireValidNamespace(namespace);
        bytes32 key = keccak256(bytes(namespace));
        verifiers[key] = verifier;
        emit VerifierUpdated(key, namespace, verifier);
    }

    /// @notice Upgrade the IdentityAccount implementation for all proxies.
    ///         All existing proxy addresses remain unchanged.
    function upgradeAccountImplementation(address newImpl) external onlyOwner {
        beacon.upgradeTo(newImpl);
    }

    function _requireValidNamespace(string calldata namespace) internal pure {
        bytes memory ns = bytes(namespace);
        require(ns.length != 0, "EntityRegistry: empty namespace");

        for (uint256 i = 0; i < ns.length; i++) {
            bytes1 c = ns[i];
            bool isDigit = c >= 0x30 && c <= 0x39;
            bool isLower = c >= 0x61 && c <= 0x7A;
            bool isHyphen = c == 0x2D;
            require(
                isDigit || isLower || isHyphen,
                "EntityRegistry: invalid namespace"
            );
        }
    }
}
