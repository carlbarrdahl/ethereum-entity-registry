import {
  type Address,
  type WalletClient,
  type PublicClient,
  createPublicClient,
  http,
} from "viem";
import { mainnet, sepolia, base, baseSepolia, hardhat } from "viem/chains";
import { createIndexer, type Indexer } from "./lib/indexer";
import { config, type SupportedChainId } from "./config";
import deployments from "@ethereum-entity-registry/contracts/deployments.json";

import { createRegistryMethods } from "./registry";
import { createAccountMethods } from "./account";

export * from "./lib/tx";
export * from "./components/provider";
export * from "./hooks";
export * from "./lib/indexer";
export { config, type SupportedChainId } from "./config";
export * from "./tokens";
export * from "./utils";
export type { IdentifierState } from "./registry";

type ChainDeployments = (typeof deployments)["31337"];

export type EntityRegistrySDKOptions = {
  /** Address of a platform-specific AccountFactory with reclaim config. */
  accountFactory?: Address;
};

function getDeployments(chainId: SupportedChainId): ChainDeployments {
  const d = deployments[chainId.toString() as keyof typeof deployments] as Record<string, unknown>;
  if (!d) throw new Error(`Chain ${chainId} not supported`);
  // Normalize legacy "CanonicalRegistry" name to "EntityRegistry"
  if (!d.EntityRegistry && d.CanonicalRegistry) {
    d.EntityRegistry = d.CanonicalRegistry;
  }
  return d as ChainDeployments;
}

function getChain(chainId: SupportedChainId) {
  switch (chainId) {
    case 1:
      return mainnet;
    case 11155111:
      return sepolia;
    case 8453:
      return base;
    case 84532:
      return baseSepolia;
    case 31337:
      return hardhat;
    default:
      return hardhat;
  }
}

export class EntityRegistrySDK {
  #wallet: WalletClient | undefined;
  #public: PublicClient;
  #chainId: SupportedChainId;
  #deployments: ChainDeployments;
  #indexer: Indexer;

  registry!: ReturnType<typeof createRegistryMethods>;
  account!: ReturnType<typeof createAccountMethods>;

  constructor(
    wallet?: WalletClient,
    defaultChain?: SupportedChainId,
    options?: EntityRegistrySDKOptions,
  ) {
    const chainId = (wallet?.chain?.id ??
      defaultChain ??
      31337) as SupportedChainId;
    const chain = getChain(chainId);

    this.#wallet = wallet;
    this.#chainId = chainId;
    this.#indexer = createIndexer(chainId);
    this.#public = createPublicClient({
      chain,
      transport: http(),
    }) as PublicClient;
    this.#deployments = getDeployments(chainId);

    this.registry = createRegistryMethods(
      wallet,
      this.#public,
      {
        ...this.#deployments,
        beaconProxyBytecode: deployments.beaconProxyBytecode,
      },
      options?.accountFactory,
    );
    this.account = createAccountMethods(wallet, this.#public, this.#deployments);
  }

  get wallet(): WalletClient | undefined {
    return this.#wallet;
  }

  get publicClient(): PublicClient {
    return this.#public;
  }

  get chainId(): SupportedChainId {
    return this.#chainId;
  }

  get indexer(): Indexer | null {
    return this.#indexer;
  }
}
