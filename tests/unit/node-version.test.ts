import { describe, expect, it } from "vitest";
import { assertSupportedNode } from "../../src/server/node-version.js";

describe("assertSupportedNode", () => {
  it.each(["22.13.0", "v22.23.1", "23.4.0", "24.0.0", "26.1.3"])("accepts %s", (version) => {
    expect(() => assertSupportedNode(version)).not.toThrow();
  });

  it.each(["22.12.9", "23.3.0", "20.18.0", "18.20.4"])("rejects %s with the exact message", (version) => {
    expect(() => assertSupportedNode(version)).toThrow(`Scheduled Prompt needs Node 22.13+ (found ${version})`);
  });
});
