// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {IdentityAccount} from "./IdentityAccount.sol";
import {IEntityRegistry} from "./IEntityRegistry.sol";

/// @title  AccountFactory
/// @notice Platform-specific factory with reclaim config.
///         Deploys IdentityAccount proxies per identifier at deterministic addresses.
///         All accounts share the factory's reclaimTo and reclaimDuration.
///
/// @dev    Uses BeaconProxy so the platform can upgrade the account implementation
///         for all its accounts without changing any proxy address.
///         Accounts resolve ownership through the shared EntityRegistry.
///         This factory is not canonical by itself; ecosystems that want one
///         canonical deposit address per identifier must coordinate on which
///         factory deployment to use.
contract AccountFactory is Ownable {
    UpgradeableBeacon public immutable beacon;
    address public immutable registry;
    address public immutable reclaimTo;
    uint256 public immutable reclaimDuration;

    event AccountDeployed(bytes32 indexed id, address account);

    constructor(
        address registry_,
        address accountImpl_,
        address reclaimTo_,
        uint256 reclaimDuration_,
        address admin
    ) Ownable(admin) {
        registry = registry_;
        reclaimTo = reclaimTo_;
        reclaimDuration = reclaimDuration_;
        beacon = new UpgradeableBeacon(accountImpl_, address(this));
    }

    function _accountInitData(bytes32 id) internal view returns (bytes memory) {
        return abi.encodeCall(IdentityAccount.initialize, (registry, id));
    }

    /// @notice Returns the deterministic address for the account proxy of `id`.
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

    /// @notice Deploy an account for `id`. Sets reclaim if the identity is unclaimed.
    function deployAccount(bytes32 id) public returns (address account) {
        require(predictAddress(id).code.length == 0, "AccountFactory: already deployed");
        account = address(new BeaconProxy{salt: id}(address(beacon), _accountInitData(id)));

        if (reclaimTo != address(0) && IEntityRegistry(registry).ownerOf(id) == address(0)) {
            IdentityAccount(payable(account)).setReclaim(reclaimTo, block.timestamp + reclaimDuration);
        }

        emit AccountDeployed(id, account);
    }

    /// @notice Batch deploy accounts for multiple identifiers.
    function deployAccounts(bytes32[] calldata ids) external {
        for (uint256 i = 0; i < ids.length; i++) {
            deployAccount(ids[i]);
        }
    }

    /// @notice Upgrade the account implementation for all proxies deployed by this factory.
    function upgradeAccountImplementation(address newImpl) external onlyOwner {
        beacon.upgradeTo(newImpl);
    }
}
