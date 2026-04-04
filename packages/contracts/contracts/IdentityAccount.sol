// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IEntityRegistry} from "./IEntityRegistry.sol";

/// @title  IdentityAccount (Implementation)
/// @notice One proxy is deployed (via CREATE2 + BeaconProxy) per canonical identifier.
///         The proxy address is deterministic, so funders can deposit before the
///         identifier is claimed — by transferring ERC-20 or ETH directly.
///         Once claimed, the registered owner can call `execute` to interact with
///         any contract through this account.
///
///         This implementation also includes an optional reclaim extension:
///         while unclaimed (before first claim or after revocation), `reclaimTo`
///         may call `execute` after `reclaimableAfter`, so recovery uses the same
///         code path as normal operation (e.g. warehouse withdraws).
///
/// @dev    Deployed behind a BeaconProxy by EntityRegistry.
///         The beacon can be upgraded to add functionality without changing any proxy address.
contract IdentityAccount is Initializable {
    IEntityRegistry public registry;
    bytes32 public id;
    address public reclaimTo;
    uint256 public reclaimableAfter;

    event ReclaimSet(bytes32 indexed id, address indexed reclaimTo, uint256 reclaimableAfter);

    constructor() {
        _disableInitializers();
    }

    function initialize(address registry_, bytes32 id_) external initializer {
        registry = IEntityRegistry(registry_);
        id = id_;
    }

    /// @notice Execute an arbitrary call through this account.
    ///         Base behavior: callable by the registered owner.
    ///         This implementation additionally allows `reclaimTo` after the deadline
    ///         while the identifier remains unclaimed.
    function execute(address target, bytes calldata data, uint256 value)
        external
        returns (bytes memory)
    {
        address owner = registry.ownerOf(id);
        bool asOwner = (owner == msg.sender);
        bool asReclaim = (
            owner == address(0) &&
            reclaimTo != address(0) &&
            msg.sender == reclaimTo &&
            block.timestamp > reclaimableAfter
        );
        require(asOwner || asReclaim, "IdentityAccount: not authorized");

        (bool success, bytes memory result) = target.call{value: value}(data);
        require(success, "IdentityAccount: call failed");
        return result;
    }

    /// @notice Set (or update) the reclaim address and deadline.
    ///         Implementation extension, not part of the minimal owner-only account model.
    ///         First caller sets it. After that, only the current reclaimTo can update.
    ///         Only callable while the identity is unclaimed.
    /// @param reclaimTo_       Address that may execute after the deadline while unclaimed.
    /// @param reclaimableAfter_ Absolute unix timestamp after which reclaim execute is allowed.
    function setReclaim(address reclaimTo_, uint256 reclaimableAfter_) external {
        require(
            reclaimTo == address(0) || msg.sender == reclaimTo,
            "IdentityAccount: not authorized"
        );
        require(registry.ownerOf(id) == address(0), "IdentityAccount: already claimed");
        require(reclaimableAfter_ > block.timestamp, "IdentityAccount: deadline in past");

        reclaimTo = reclaimTo_;
        reclaimableAfter = reclaimableAfter_;

        emit ReclaimSet(id, reclaimTo_, reclaimableAfter_);
    }

    receive() external payable {}
}
