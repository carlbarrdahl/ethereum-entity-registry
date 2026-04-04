import {
  type Abi,
  type Address,
  type WalletClient,
  type PublicClient,
  encodeFunctionData,
  getContract,
} from "viem";
import { writeAndWait } from "./lib/tx";

type ChainDeployments = {
  IdentityAccount: { abi: unknown };
};

const erc20Abi = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const warehouseAbi = [
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [],
  },
] as const;

const erc721Abi = [
  {
    name: "transferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const reclaimConfigAbi = [
  {
    name: "setReclaim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "reclaimTo_", type: "address" },
      { name: "reclaimableAfter_", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "reclaimTo",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "reclaimableAfter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export function createAccountMethods(
  wallet: WalletClient | undefined,
  publicClient: PublicClient,
  deployments: ChainDeployments,
) {
  const accountAbi = deployments.IdentityAccount.abi as Abi;

  return {
    /**
     * Execute an arbitrary call through an IdentityAccount.
     * Callable by the registered owner, or by `reclaimTo` after `reclaimableAfter`
     * while the identity is still unclaimed (read reclaim fields via `reclaimTo` / `reclaimableAfter`).
     */
    execute: async (
      accountAddress: Address,
      target: Address,
      data: `0x${string}`,
      value?: bigint,
    ): Promise<{ hash: `0x${string}` }> => {
      if (!wallet) throw new Error("Wallet required");
      const contract = getContract({
        address: accountAddress,
        abi: accountAbi,
        client: { public: publicClient, wallet },
      });
      const hash = await (contract as any).write.execute(
        [target, data, value ?? 0n],
        { account: wallet.account! },
      );
      return writeAndWait(wallet, hash);
    },

    /**
     * Encode an ERC-20 transfer from the identity account to a recipient.
     *
     * @example
     * const { target, data } = sdk.account.encodeERC20Transfer(tokenAddress, recipient, amount);
     * await sdk.account.execute(accountAddress, target, data);
     */
    encodeERC20Transfer: (token: Address, to: Address, amount: bigint) => ({
      target: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    }),

    /**
     * Encode a Splits Warehouse withdrawal to pull tokens owed to the identity account.
     *
     * @example
     * const { target, data } = sdk.account.encodeWarehouseWithdraw(warehouseAddress, accountAddress, tokenAddress);
     * await sdk.account.execute(accountAddress, target, data);
     */
    encodeWarehouseWithdraw: (warehouse: Address, owner: Address, token: Address) => ({
      target: warehouse,
      data: encodeFunctionData({ abi: warehouseAbi, functionName: "withdraw", args: [owner, token] }),
    }),

    /**
     * Encode an ERC-721 transfer from the identity account.
     *
     * @example
     * const { target, data } = sdk.account.encodeERC721Transfer(nftAddress, accountAddress, recipient, tokenId);
     * await sdk.account.execute(accountAddress, target, data);
     */
    encodeERC721Transfer: (nft: Address, from: Address, to: Address, tokenId: bigint) => ({
      target: nft,
      data: encodeFunctionData({ abi: erc721Abi, functionName: "transferFrom", args: [from, to, tokenId] }),
    }),

    /**
     * Set (or update) the reclaim address and deadline on an identity account.
     * First caller sets it. After that, only the current reclaimTo can update.
     * Only callable while the identity is unclaimed.
     *
     * @param accountAddress   The identity account address.
     * @param reclaimTo        Address that can reclaim funds after the deadline.
     * @param reclaimableAfter Absolute unix timestamp after which reclaim is allowed.
     */
    setReclaim: async (
      accountAddress: Address,
      reclaimTo: Address,
      reclaimableAfter: bigint,
    ): Promise<{ hash: `0x${string}` }> => {
      if (!wallet) throw new Error("Wallet required");
      const contract = getContract({
        address: accountAddress,
        abi: reclaimConfigAbi,
        client: { public: publicClient, wallet },
      });
      const hash = await (contract as any).write.setReclaim(
        [reclaimTo, reclaimableAfter],
        { account: wallet.account! },
      );
      return writeAndWait(wallet, hash);
    },

    /**
     * Read the absolute reclaim deadline (unix timestamp) for an account.
     * Returns 0 if reclaim has not been set.
     */
    reclaimableAfter: async (accountAddress: Address): Promise<bigint> => {
      const contract = getContract({
        address: accountAddress,
        abi: reclaimConfigAbi,
        client: { public: publicClient },
      });
      return (contract as any).read.reclaimableAfter();
    },

    /**
     * Read the reclaim address for an account.
     * Returns zeroAddress if reclaim has not been set.
     */
    reclaimTo: async (accountAddress: Address): Promise<Address> => {
      const contract = getContract({
        address: accountAddress,
        abi: reclaimConfigAbi,
        client: { public: publicClient },
      });
      return (contract as any).read.reclaimTo();
    },
  };
}
