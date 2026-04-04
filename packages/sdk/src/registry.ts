import {
  type Abi,
  type Address,
  type WalletClient,
  type PublicClient,
  getContract,
  zeroAddress,
} from "viem";
import { writeAndWait } from "./lib/tx";
import { canonicalise, toId, resolveDepositAddress, parseAnyIdentifier } from "./utils";
import { isNativeToken } from "./tokens";

export type IdentifierState = {
  id: `0x${string}`;
  depositAddress: Address;
  balance: bigint | null;
};

type ChainDeployments = {
  EntityRegistry: { address: string; abi: unknown };
  beaconProxyBytecode?: string;
};

const accountFactoryAbi = [
  {
    name: "predictAddress",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "deployAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "account", type: "address" }],
  },
  {
    name: "deployAccounts",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "ids", type: "bytes32[]" }],
    outputs: [],
  },
] as const;

export function createRegistryMethods(
  wallet: WalletClient | undefined,
  publicClient: PublicClient,
  deployments: ChainDeployments,
  accountFactory?: Address,
) {
  const registryAddress = deployments.EntityRegistry.address as Address;
  const beaconProxyBytecode = (deployments.beaconProxyBytecode ?? "") as `0x${string}`;
  const registryAbi = deployments.EntityRegistry.abi as Abi;

  function getRegistryContract() {
    return getContract({
      address: registryAddress,
      abi: registryAbi,
      client: { public: publicClient, wallet: wallet! },
    });
  }

  function getFactoryReadContract() {
    return getContract({
      address: accountFactory!,
      abi: accountFactoryAbi,
      client: { public: publicClient },
    });
  }

  const erc20Abi = [
    {
      name: "balanceOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as const;

  async function predictAddressById(id: `0x${string}`): Promise<Address> {
    if (accountFactory) {
      return (getFactoryReadContract() as any).read.predictAddress([id]);
    }
    const contract = getContract({
      address: registryAddress,
      abi: registryAbi,
      client: { public: publicClient },
    });
    return (contract as any).read.predictAddress([id]);
  }

  async function resolveById(
    namespace: string,
    rawCanonicalString: string,
    token?: Address,
  ): Promise<IdentifierState> {
    const cs = canonicalise(rawCanonicalString);
    const id = toId(namespace, cs);

    let depositAddress: Address;
    if (accountFactory) {
      depositAddress = await (getFactoryReadContract() as any).read.predictAddress([id]);
    } else if (beaconProxyBytecode) {
      depositAddress = resolveDepositAddress(id, registryAddress, beaconProxyBytecode);
    } else {
      depositAddress = await (getContract({
        address: registryAddress,
        abi: registryAbi,
        client: { public: publicClient },
      }) as any).read.predictAddress([id]);
    }

    const balance = token
      ? isNativeToken(token)
        ? await publicClient.getBalance({ address: depositAddress })
        : await publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [depositAddress],
          })
      : null;

    return {
      id,
      depositAddress,
      balance,
    };
  }

  return {
    /**
     * Get the registered owner of an identifier (resolves through aliases).
     * Returns null if unclaimed.
     */
    ownerOf: async (id: `0x${string}`): Promise<Address | null> => {
      const contract = getContract({
        address: registryAddress,
        abi: registryAbi,
        client: { public: publicClient },
      });
      const owner: Address = await (contract as any).read.ownerOf([id]);
      return owner === zeroAddress ? null : owner;
    },

    /**
     * Get the deterministic account address for an identifier.
     * When an account factory is configured, returns the account address
     * computed by that factory.
     */
    predictAddress: (id: `0x${string}`): Promise<Address> => {
      return predictAddressById(id);
    },

    /**
     * Claim ownership of an identifier with an oracle proof.
     *
     * @example
     * sdk.registry.claim("github.com/org/repo", proof)
     * sdk.registry.claim("example.com", proof)
     * sdk.registry.claim("github:org/repo", proof)
     */
    claim: async (
      input: string,
      proof: `0x${string}`,
    ): Promise<{ hash: `0x${string}` }> => {
      if (!wallet) throw new Error("Wallet required");
      const { namespace, canonicalString } = parseAnyIdentifier(input);
      const contract = getRegistryContract();
      const hash = await (contract as any).write.claim(
        [namespace, canonicalString, proof],
        { account: wallet.account! },
      );
      return writeAndWait(wallet, hash);
    },

    /**
     * Revoke ownership of an identifier.
     *
     * @example
     * sdk.registry.revoke("github.com/org/repo")
     * sdk.registry.revoke("example.com")
     */
    revoke: async (
      input: string,
    ): Promise<{ hash: `0x${string}` }> => {
      if (!wallet) throw new Error("Wallet required");
      const { namespace, canonicalString } = parseAnyIdentifier(input);
      const contract = getRegistryContract();
      const hash = await (contract as any).write.revoke(
        [namespace, canonicalString],
        { account: wallet.account! },
      );
      return writeAndWait(wallet, hash);
    },

    /**
     * Link alias identifiers to a primary identifier.
     */
    linkIds: async (
      primaryId: `0x${string}`,
      aliasIds: `0x${string}`[],
    ): Promise<{ hash: `0x${string}` }> => {
      if (!wallet) throw new Error("Wallet required");
      const contract = getRegistryContract();
      const hash = await (contract as any).write.linkIds(
        [primaryId, aliasIds],
        { account: wallet.account! },
      );
      return writeAndWait(wallet, hash);
    },

    /**
     * Unlink alias identifiers from their primary.
     */
    unlinkIds: async (
      primaryId: `0x${string}`,
      aliasIds: `0x${string}`[],
    ): Promise<{ hash: `0x${string}` }> => {
      if (!wallet) throw new Error("Wallet required");
      const contract = getRegistryContract();
      const hash = await (contract as any).write.unlinkIds(
        [primaryId, aliasIds],
        { account: wallet.account! },
      );
      return writeAndWait(wallet, hash);
    },

    /**
     * Deploy the IdentityAccount proxy for an identifier (permissionless).
     * When an account factory is configured, deploys via the factory
     * (which automatically sets reclaim).
     */
    deployAccount: async (
      id: `0x${string}`,
    ): Promise<{ hash: `0x${string}` }> => {
      if (!wallet) throw new Error("Wallet required");
      if (accountFactory) {
        const contract = getContract({
          address: accountFactory,
          abi: accountFactoryAbi,
          client: { public: publicClient, wallet },
        });
        const hash = await (contract as any).write.deployAccount([id], {
          account: wallet.account!,
        });
        return writeAndWait(wallet, hash);
      }
      const contract = getRegistryContract();
      const hash = await (contract as any).write.deployAccount([id], {
        account: wallet.account!,
      });
      return writeAndWait(wallet, hash);
    },

    /**
     * Batch deploy accounts for multiple identifiers in a single transaction.
     * Requires an account factory to be configured.
     */
    deployAccounts: async (
      ids: `0x${string}`[],
    ): Promise<{ hash: `0x${string}` }> => {
      if (!wallet) throw new Error("Wallet required");
      if (!accountFactory) throw new Error("Account factory required for batch deploy");
      const contract = getContract({
        address: accountFactory,
        abi: accountFactoryAbi,
        client: { public: publicClient, wallet },
      });
      const hash = await (contract as any).write.deployAccounts([ids], {
        account: wallet.account!,
      });
      return writeAndWait(wallet, hash);
    },

    /**
     * Admin: set or replace the verifier for a namespace.
     */
    setVerifier: async (
      namespace: string,
      verifier: Address,
    ): Promise<{ hash: `0x${string}` }> => {
      if (!wallet) throw new Error("Wallet required");
      const contract = getRegistryContract();
      const hash = await (contract as any).write.setVerifier(
        [namespace, verifier],
        { account: wallet.account! },
      );
      return writeAndWait(wallet, hash);
    },

    /**
     * Compute the deterministic identifier for a namespace + canonical string.
     */
    toId: (namespace: string, canonicalString: string): `0x${string}` => {
      return toId(namespace, canonicalString);
    },

    /**
     * Check whether the IdentityAccount for an identifier has been deployed.
     * When an account factory is configured, checks the account address
     * computed by that factory.
     */
    isAccountDeployed: async (id: `0x${string}`): Promise<boolean> => {
      const depositAddress = await predictAddressById(id);
      const code = await publicClient.getBytecode({ address: depositAddress });
      return code !== undefined && code !== "0x";
    },

    /**
     * Resolve the deposit address and optional ERC-20 balance for an identifier.
     * The deposit address is computed locally (no RPC). Balance requires one RPC call.
     *
     * @example
     * const state = await sdk.registry.resolveIdentifier("github", "org/repo", tokenAddress)
     * // state.depositAddress — where funders should send tokens
     * // state.balance        — claimable token balance at the deposit address
     */
    resolveIdentifier: (
      namespace: string,
      rawCanonicalString: string,
      token?: Address,
    ): Promise<IdentifierState> => resolveById(namespace, rawCanonicalString, token),

    /**
     * Resolve any free-form identifier string to its deposit address and optional balance.
     * Accepts namespace:value, URLs, and domain names.
     *
     * @example
     * sdk.registry.resolve("github:org/repo")
     * sdk.registry.resolve("github.com/org/repo")
     * sdk.registry.resolve("https://github.com/org/repo")
     * sdk.registry.resolve("dns:example.com")
     * sdk.registry.resolve("www.example.com")
     * sdk.registry.resolve("npm:package-name")
     * sdk.registry.resolve("npmjs.com/package/foo")
     */
    resolve: (input: string, token?: Address): Promise<IdentifierState> => {
      const { namespace, canonicalString } = parseAnyIdentifier(input);
      return resolveById(namespace, canonicalString, token);
    },
  };
}
