import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  getContractAddress,
  concat,
  type Hex,
  type Address,
} from "viem";

const NAMESPACE_REGEX = /^[a-z0-9-]+$/;

// ============================================================================
// Canonicalisation
// ============================================================================

/**
 * Default canonicalisation: lowercase, trim whitespace, strip trailing slash.
 * Baseline for all namespaces (github, dns).
 * The contract does not enforce any normalisation — consistency is the caller's
 * responsibility.
 */
export function canonicalise(value: string): string {
  return value.toLowerCase().trim().replace(/\/$/, "");
}

function assertValidNamespace(namespace: string): void {
  if (!NAMESPACE_REGEX.test(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}". Namespace labels must match [a-z0-9-]+`,
    );
  }
}

// ============================================================================
// Identifier helpers
// ============================================================================

/**
 * Derive the bytes32 identifier for a (namespace, canonicalString) pair.
 * Matches: keccak256(abi.encode(namespace, canonicalString))
 *
 * This is a pure local computation — no RPC call required.
 */
export function toId(namespace: string, canonicalString: string): Hex {
  assertValidNamespace(namespace);
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string, string"), [
      namespace,
      canonicalString,
    ]),
  );
}

/**
 * Format namespace + canonicalString into a human-readable identifier string.
 * e.g. formatIdentifier("github", "org/repo") → "github:org/repo"
 */
export function formatIdentifier(
  namespace: string,
  canonicalString: string,
): string {
  assertValidNamespace(namespace);
  return `${namespace}:${canonicalString}`;
}

/**
 * Parse a colon-separated identifier string into its parts.
 * e.g. parseIdentifier("github:org/repo") → { namespace: "github", canonicalString: "org/repo" }
 */
export function parseIdentifier(identifier: string): {
  namespace: string;
  canonicalString: string;
} {
  const colonIndex = identifier.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid identifier (missing namespace): "${identifier}"`,
    );
  }
  const namespace = identifier.slice(0, colonIndex);
  assertValidNamespace(namespace);
  return {
    namespace,
    canonicalString: identifier.slice(colonIndex + 1),
  };
}

// ============================================================================
// URL parsing
// ============================================================================

export type ParsedUrl = {
  namespace: string;
  canonicalString: string;
  /** The normalised form, suitable for display: e.g. "github:org/repo" */
  formatted: string;
};

/**
 * Parse a free-form URL or handle into a registry identifier.
 *
 * Accepts all of the following for a GitHub repo:
 *   github.com/org/repo
 *   https://github.com/org/repo
 *   https://www.github.com/org/repo/tree/main  (extra path segments ignored)
 *
 * Accepts all of the following for a DNS domain:
 *   example.com
 *   https://example.com
 *   https://www.example.com/some/path          (path ignored)
 *
 * Throws if the input cannot be mapped to a known namespace.
 */
export function parseUrl(input: string): ParsedUrl {
  const raw = input.trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Cannot parse "${input}" as a URL`);
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const pathParts = url.pathname.split("/").filter(Boolean);

  if (host === "github.com") {
    if (pathParts.length < 2) {
      throw new Error(
        `GitHub URL must include owner and repo: "${input}"`,
      );
    }
    const canonicalString = `${pathParts[0]}/${pathParts[1]}`.toLowerCase();
    return {
      namespace: "github",
      canonicalString,
      formatted: `github:${canonicalString}`,
    };
  }

  if (host === "npmjs.com") {
    // https://www.npmjs.com/package/foo → npm:foo
    const pkgIdx = pathParts.indexOf("package");
    const pkgName = pkgIdx !== -1 ? pathParts[pkgIdx + 1] : undefined;
    if (pkgName) {
      const canonicalString = pkgName.toLowerCase();
      return {
        namespace: "npm",
        canonicalString,
        formatted: `npm:${canonicalString}`,
      };
    }
    throw new Error(`npmjs.com URL must include a package name: "${input}"`);
  }

  if (host.includes(".")) {
    return {
      namespace: "dns",
      canonicalString: host,
      formatted: `dns:${host}`,
    };
  }

  throw new Error(`Cannot determine namespace for "${input}"`);
}

/**
 * Parse any free-form identifier string into namespace + canonicalString.
 *
 * Handles all of these forms:
 *   github:org/repo          → namespace:value  (explicit prefix)
 *   dns:example.com          → namespace:value
 *   npm:package-name         → namespace:value
 *   github.com/org/repo      → URL-style
 *   https://github.com/...   → URL-style
 *   www.example.com          → URL-style
 */
export function parseAnyIdentifier(input: string): {
  namespace: string;
  canonicalString: string;
} {
  const trimmed = input.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    return parseUrl(trimmed);
  }

  // "namespace:value" — colon exists and nothing before it looks like a URL host
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0 && !/[./]/.test(trimmed.slice(0, colonIdx))) {
    return parseIdentifier(trimmed);
  }

  return parseUrl(trimmed);
}

// ============================================================================
// Deposit address derivation (no RPC required)
// ============================================================================

/**
 * Derive the beacon address from the registry address.
 *
 * The beacon is deployed with `new UpgradeableBeacon(...)` as the first
 * contract created in the EntityRegistry constructor. Per EIP-161, a new
 * contract starts with nonce=1, so the beacon address is the CREATE address
 * of (registryAddress, nonce=1).
 *
 * This is a pure local computation — no RPC call required.
 */
export function deriveBeaconAddress(registryAddress: Address): Address {
  return getContractAddress({ opcode: "CREATE", from: registryAddress, nonce: 1n });
}

/**
 * Compute the deterministic deposit address for any identifier.
 * This is a pure local computation — no RPC call required.
 *
 * The address is stable whether or not the escrow proxy has been deployed,
 * and does NOT change if the escrow implementation is upgraded via the beacon.
 *
 * @param id               bytes32 identifier from toId()
 * @param registryAddress  deployed EntityRegistry address
 * @param beaconProxyBytecode  creation bytecode of OpenZeppelin BeaconProxy
 *                             (available as deployments.beaconProxyBytecode)
 */
export function resolveDepositAddress(
  id: Hex,
  registryAddress: Address,
  beaconProxyBytecode: Hex,
): Address {
  const beaconAddress = deriveBeaconAddress(registryAddress);

  const initializeCalldata = encodeFunctionData({
    abi: [
      {
        name: "initialize",
        type: "function",
        inputs: [
          { name: "registry_", type: "address" },
          { name: "id_", type: "bytes32" },
        ],
      },
    ],
    functionName: "initialize",
    args: [registryAddress, id],
  });

  const constructorArgs = encodeAbiParameters(
    parseAbiParameters("address, bytes"),
    [beaconAddress, initializeCalldata],
  );

  const initcode = concat([beaconProxyBytecode, constructorArgs]);
  const initcodeHash = keccak256(initcode);

  return getContractAddress({
    opcode: "CREATE2",
    from: registryAddress,
    salt: id,
    bytecodeHash: initcodeHash,
  });
}
