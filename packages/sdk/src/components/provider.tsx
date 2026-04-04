"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";
import {
  EntityRegistrySDK,
  type EntityRegistrySDKOptions,
  type SupportedChainId,
} from "..";
import type { WalletClient } from "viem";

type EntityRegistryContextValue<T extends EntityRegistrySDK = EntityRegistrySDK> = {
  sdk: T | null;
};

const EntityRegistryContext = createContext<EntityRegistryContextValue>({
  sdk: null,
});

type EntityRegistryProviderProps<T extends EntityRegistrySDK> = PropsWithChildren<{
  client?: WalletClient;
  defaultChain?: SupportedChainId;
  options?: EntityRegistrySDKOptions;
}>;

export function EntityRegistryProvider<T extends EntityRegistrySDK = EntityRegistrySDK>({
  children,
  client,
  defaultChain,
  options,
}: EntityRegistryProviderProps<T>): React.ReactNode {
  const [sdk, setSdk] = useState<EntityRegistrySDK | null>(null);

  useEffect(() => {
    setSdk(new EntityRegistrySDK(client, defaultChain, options));
  }, [client, defaultChain, options]);

  return (
    <EntityRegistryContext.Provider value={{ sdk }}>
      {children}
    </EntityRegistryContext.Provider>
  );
}

export function useEntityRegistrySDK<T extends EntityRegistrySDK = EntityRegistrySDK>(): {
  sdk: T | null;
} {
  const context = useContext(EntityRegistryContext);
  if (!context) {
    throw new Error("useEntityRegistrySDK must be used within a EntityRegistryProvider");
  }
  return context as { sdk: T | null };
}
