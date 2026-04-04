import { describe, it, expect } from "vitest";
import {
  canonicalise,
  toId,
  formatIdentifier,
  parseIdentifier,
  parseUrl,
  parseAnyIdentifier,
} from "../utils";

describe("canonicalise", () => {
  it("lowercases input", () => {
    expect(canonicalise("ORG/REPO")).toBe("org/repo");
  });

  it("trims whitespace", () => {
    expect(canonicalise("  org/repo  ")).toBe("org/repo");
  });

  it("strips trailing slash", () => {
    expect(canonicalise("org/repo/")).toBe("org/repo");
  });

  it("handles already-canonical input", () => {
    expect(canonicalise("org/repo")).toBe("org/repo");
  });
});

describe("toId", () => {
  it("returns a 0x-prefixed hex string", () => {
    const id = toId("github", "org/repo");
    expect(id).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    expect(toId("github", "org/repo")).toBe(toId("github", "org/repo"));
  });

  it("differs across namespaces", () => {
    expect(toId("github", "org/repo")).not.toBe(toId("dns", "org/repo"));
  });

  it("differs across canonical strings", () => {
    expect(toId("github", "org/repo")).not.toBe(toId("github", "org/other"));
  });

  it("rejects invalid namespace labels", () => {
    expect(() => toId("GitHub", "org/repo")).toThrow("[a-z0-9-]+");
    expect(() => toId("github repo", "org/repo")).toThrow("[a-z0-9-]+");
  });
});

describe("formatIdentifier", () => {
  it("joins namespace and canonicalString with a colon", () => {
    expect(formatIdentifier("github", "org/repo")).toBe("github:org/repo");
  });

  it("works for dns namespace", () => {
    expect(formatIdentifier("dns", "example.com")).toBe("dns:example.com");
  });

  it("rejects invalid namespace labels", () => {
    expect(() => formatIdentifier("GitHub", "org/repo")).toThrow("[a-z0-9-]+");
  });
});

describe("parseIdentifier", () => {
  it("parses github:org/repo", () => {
    expect(parseIdentifier("github:org/repo")).toEqual({
      namespace: "github",
      canonicalString: "org/repo",
    });
  });

  it("parses dns:example.com", () => {
    expect(parseIdentifier("dns:example.com")).toEqual({
      namespace: "dns",
      canonicalString: "example.com",
    });
  });

  it("parses npm:package-name", () => {
    expect(parseIdentifier("npm:package-name")).toEqual({
      namespace: "npm",
      canonicalString: "package-name",
    });
  });

  it("preserves everything after the first colon", () => {
    expect(parseIdentifier("custom:foo:bar")).toEqual({
      namespace: "custom",
      canonicalString: "foo:bar",
    });
  });

  it("throws when there is no colon", () => {
    expect(() => parseIdentifier("nocolon")).toThrow();
  });

  it("rejects invalid namespace labels", () => {
    expect(() => parseIdentifier("GitHub:org/repo")).toThrow("[a-z0-9-]+");
    expect(() => parseIdentifier("github repo:org/repo")).toThrow("[a-z0-9-]+");
  });
});

describe("parseUrl", () => {
  describe("github.com", () => {
    it("parses github.com/org/repo", () => {
      expect(parseUrl("github.com/org/repo")).toEqual({
        namespace: "github",
        canonicalString: "org/repo",
        formatted: "github:org/repo",
      });
    });

    it("parses https://github.com/org/repo", () => {
      expect(parseUrl("https://github.com/org/repo")).toEqual({
        namespace: "github",
        canonicalString: "org/repo",
        formatted: "github:org/repo",
      });
    });

    it("strips www prefix", () => {
      expect(parseUrl("https://www.github.com/org/repo")).toEqual({
        namespace: "github",
        canonicalString: "org/repo",
        formatted: "github:org/repo",
      });
    });

    it("ignores extra path segments beyond owner/repo", () => {
      expect(parseUrl("https://github.com/org/repo/tree/main")).toEqual({
        namespace: "github",
        canonicalString: "org/repo",
        formatted: "github:org/repo",
      });
    });

    it("lowercases the canonical string", () => {
      expect(parseUrl("github.com/Org/Repo")).toEqual({
        namespace: "github",
        canonicalString: "org/repo",
        formatted: "github:org/repo",
      });
    });

    it("throws when missing repo segment", () => {
      expect(() => parseUrl("github.com/org")).toThrow();
    });
  });

  describe("npmjs.com", () => {
    it("parses npmjs.com/package/foo", () => {
      expect(parseUrl("npmjs.com/package/foo")).toEqual({
        namespace: "npm",
        canonicalString: "foo",
        formatted: "npm:foo",
      });
    });

    it("parses https://www.npmjs.com/package/foo", () => {
      expect(parseUrl("https://www.npmjs.com/package/foo")).toEqual({
        namespace: "npm",
        canonicalString: "foo",
        formatted: "npm:foo",
      });
    });

    it("throws when missing package segment", () => {
      expect(() => parseUrl("npmjs.com")).toThrow();
    });
  });

  describe("dns fallback", () => {
    it("parses example.com as dns", () => {
      expect(parseUrl("example.com")).toEqual({
        namespace: "dns",
        canonicalString: "example.com",
        formatted: "dns:example.com",
      });
    });

    it("strips www prefix for dns", () => {
      expect(parseUrl("www.example.com")).toEqual({
        namespace: "dns",
        canonicalString: "example.com",
        formatted: "dns:example.com",
      });
    });

    it("ignores path for dns", () => {
      expect(parseUrl("https://example.com/some/path")).toEqual({
        namespace: "dns",
        canonicalString: "example.com",
        formatted: "dns:example.com",
      });
    });
  });
});

describe("parseAnyIdentifier", () => {
  it("routes github:org/repo via parseIdentifier", () => {
    expect(parseAnyIdentifier("github:org/repo")).toEqual({
      namespace: "github",
      canonicalString: "org/repo",
    });
  });

  it("routes dns:example.com via parseIdentifier", () => {
    expect(parseAnyIdentifier("dns:example.com")).toEqual({
      namespace: "dns",
      canonicalString: "example.com",
    });
  });

  it("routes npm:package-name via parseIdentifier", () => {
    expect(parseAnyIdentifier("npm:package-name")).toEqual({
      namespace: "npm",
      canonicalString: "package-name",
    });
  });

  it("routes github.com/org/repo via parseUrl", () => {
    expect(parseAnyIdentifier("github.com/org/repo")).toEqual(
      expect.objectContaining({ namespace: "github", canonicalString: "org/repo" }),
    );
  });

  it("routes https://github.com/org/repo via parseUrl", () => {
    expect(parseAnyIdentifier("https://github.com/org/repo")).toEqual(
      expect.objectContaining({ namespace: "github", canonicalString: "org/repo" }),
    );
  });

  it("routes www.example.com via parseUrl", () => {
    expect(parseAnyIdentifier("www.example.com")).toEqual(
      expect.objectContaining({ namespace: "dns", canonicalString: "example.com" }),
    );
  });

  it("routes npmjs.com/package/foo via parseUrl", () => {
    expect(parseAnyIdentifier("npmjs.com/package/foo")).toEqual(
      expect.objectContaining({ namespace: "npm", canonicalString: "foo" }),
    );
  });

  it("trims leading/trailing whitespace", () => {
    expect(parseAnyIdentifier("  github:org/repo  ")).toEqual(
      expect.objectContaining({ namespace: "github", canonicalString: "org/repo" }),
    );
  });

  it("does not treat https:// as namespace:value", () => {
    expect(parseAnyIdentifier("https://github.com/org/repo")).toEqual(
      expect.objectContaining({ namespace: "github", canonicalString: "org/repo" }),
    );
  });
});
