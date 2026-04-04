"use client";

import { useEntityRegistrySDK } from "../components/provider";
import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { Address } from "viem";
import { useInvalidate } from "./utils";

type QueryOptions = {
  enabled?: boolean;
  refetchInterval?: number;
};

export function useExecute(
  opts?: UseMutationOptions<
    { hash: `0x${string}` },
    Error,
    { accountAddress: Address; target: Address; data: `0x${string}`; value?: bigint }
  >,
) {
  const { sdk } = useEntityRegistrySDK();
  const invalidate = useInvalidate();

  return useMutation({
    mutationFn: async ({
      accountAddress,
      target,
      data,
      value,
    }: {
      accountAddress: Address;
      target: Address;
      data: `0x${string}`;
      value?: bigint;
    }) => {
      if (!sdk) throw new Error("SDK not initialized");
      return sdk.account.execute(accountAddress, target, data, value);
    },
    onSuccess: (data, variables, ...args) => {
      toast.success("Transaction executed");
      invalidate([["identifiers"], ["identifier"]]);
      opts?.onSuccess?.(data, variables, ...args);
    },
    onError: (error, ...args) => {
      toast.error(error.message || "Failed to execute transaction");
      opts?.onError?.(error, ...args);
    },
    ...opts,
  });
}

export function useSetReclaim(
  opts?: UseMutationOptions<
    { hash: `0x${string}` },
    Error,
    { accountAddress: Address; reclaimTo: Address; reclaimableAfter: bigint }
  >,
) {
  const { sdk } = useEntityRegistrySDK();
  const invalidate = useInvalidate();

  return useMutation({
    mutationFn: async ({
      accountAddress,
      reclaimTo,
      reclaimableAfter,
    }: {
      accountAddress: Address;
      reclaimTo: Address;
      reclaimableAfter: bigint;
    }) => {
      if (!sdk) throw new Error("SDK not initialized");
      return sdk.account.setReclaim(accountAddress, reclaimTo, reclaimableAfter);
    },
    onSuccess: (data, variables, ...args) => {
      toast.success("Reclaim configured");
      invalidate([
        ["account", "reclaimTo", variables.accountAddress],
        ["account", "reclaimableAfter", variables.accountAddress],
      ]);
      opts?.onSuccess?.(data, variables, ...args);
    },
    onError: (error, ...args) => {
      toast.error(error.message || "Failed to set reclaim");
      opts?.onError?.(error, ...args);
    },
    ...opts,
  });
}

export function useReclaimableAfter(
  accountAddress: Address | undefined,
  opts?: QueryOptions,
): UseQueryResult<bigint | null> {
  const { sdk } = useEntityRegistrySDK();
  return useQuery({
    queryKey: ["account", "reclaimableAfter", accountAddress],
    queryFn: async () => {
      if (!accountAddress || !sdk) return null;
      return sdk.account.reclaimableAfter(accountAddress);
    },
    enabled:
      Boolean(sdk) && Boolean(accountAddress) && (opts?.enabled ?? true),
    refetchInterval: opts?.refetchInterval,
  });
}

export function useReclaimTo(
  accountAddress: Address | undefined,
  opts?: QueryOptions,
): UseQueryResult<Address | null> {
  const { sdk } = useEntityRegistrySDK();
  return useQuery({
    queryKey: ["account", "reclaimTo", accountAddress],
    queryFn: async () => {
      if (!accountAddress || !sdk) return null;
      return sdk.account.reclaimTo(accountAddress);
    },
    enabled:
      Boolean(sdk) && Boolean(accountAddress) && (opts?.enabled ?? true),
    refetchInterval: opts?.refetchInterval,
  });
}
