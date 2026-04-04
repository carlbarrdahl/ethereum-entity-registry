"use client";
import { PropsWithChildren, useMemo } from "react";

import { createConfig, http, useWalletClient, WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Address } from "viem";

import { EntityRegistryProvider } from "@ethereum-entity-registry/sdk";
import { hardhat, sepolia, baseSepolia } from "viem/chains";
import { Toaster } from "@ethereum-entity-registry/ui/components/sonner";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import {
  RainbowKitProvider,
  connectorsForWallets,
} from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  walletConnectWallet,
  coinbaseWallet,
  rainbowWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { rainbowkitBurnerWallet } from "burner-connector";

import "@rainbow-me/rainbowkit/styles.css";

const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [
        metaMaskWallet,
        walletConnectWallet,
        coinbaseWallet,
        rainbowWallet,
      ],
    },
    {
      groupName: "Development",
      wallets: [rainbowkitBurnerWallet],
    },
  ],
  {
    appName: "Curator",
    projectId:
      process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "YOUR_PROJECT_ID",
  },
);
const isDev = process.env.NODE_ENV === "development";
export const defaultChain = isDev ? hardhat : baseSepolia;
const config = createConfig({
  chains: isDev ? [hardhat, baseSepolia] : [baseSepolia],
  connectors,
  defaultChain,
  transports: {
    [hardhat.id]: http(),
    [sepolia.id]: http(
      process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    ),
    [baseSepolia.id]: http(
      process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    ),
  },
});

const queryClient = new QueryClient();

function getAccountFactoryForChain(chainId: number): Address | undefined {
  const generic = process.env.NEXT_PUBLIC_ACCOUNT_FACTORY_ADDRESS;

  switch (chainId) {
    case hardhat.id:
      return (
        process.env.NEXT_PUBLIC_HARDHAT_ACCOUNT_FACTORY_ADDRESS ??
        generic ??
        undefined
      ) as Address | undefined;
    case sepolia.id:
      return (
        process.env.NEXT_PUBLIC_SEPOLIA_ACCOUNT_FACTORY_ADDRESS ??
        generic ??
        undefined
      ) as Address | undefined;
    case baseSepolia.id:
      return (
        process.env.NEXT_PUBLIC_BASE_SEPOLIA_ACCOUNT_FACTORY_ADDRESS ??
        generic ??
        undefined
      ) as Address | undefined;
    default:
      return generic as Address | undefined;
  }
}

export function Providers({ children }: PropsWithChildren) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <NextThemesProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          enableColorScheme
        >
          <RainbowKitProvider>
            <Registry>
              {children}
              <Toaster />
            </Registry>
          </RainbowKitProvider>
        </NextThemesProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function Registry({ children }: PropsWithChildren) {
  const { data: client } = useWalletClient();
  const effectiveChainId = client?.chain?.id ?? defaultChain.id;
  const accountFactory = getAccountFactoryForChain(effectiveChainId);
  const options = useMemo(
    () => (accountFactory ? { accountFactory } : undefined),
    [accountFactory],
  );

  return (
    <EntityRegistryProvider
      client={client}
      defaultChain={defaultChain.id}
      options={options}
    >
      {children}
    </EntityRegistryProvider>
  );
}
