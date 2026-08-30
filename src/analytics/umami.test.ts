import { describe, expect, test } from "bun:test";
import { resolveUmamiConfig } from "./umami";

describe("resolveUmamiConfig", () => {
  test("is off without a website id", () => {
    expect(resolveUmamiConfig({})).toBeNull();
    expect(resolveUmamiConfig({ websiteId: "" })).toBeNull();
    expect(resolveUmamiConfig({ websiteId: "   " })).toBeNull();
  });

  test("stays off even when the other variables are set", () => {
    expect(
      resolveUmamiConfig({
        scriptUrl: "https://example.com/script.js",
        domains: "firework.sh",
      }),
    ).toBeNull();
  });

  test("falls back to the project's instance", () => {
    expect(resolveUmamiConfig({ websiteId: "abc" })).toEqual({
      websiteId: "abc",
      scriptUrl: "https://linesofcode-umami.vercel.app/script.js",
    });
  });

  test("accepts an origin as well as a script URL", () => {
    for (const scriptUrl of [
      "https://umami.example.com",
      "https://umami.example.com/",
    ]) {
      expect(
        resolveUmamiConfig({ websiteId: "abc", scriptUrl })?.scriptUrl,
      ).toBe("https://umami.example.com/script.js");
    }

    expect(
      resolveUmamiConfig({
        websiteId: "abc",
        scriptUrl: "https://umami.example.com/custom.js",
      })?.scriptUrl,
    ).toBe("https://umami.example.com/custom.js");
  });

  test("passes domains through, and omits them when blank", () => {
    expect(
      resolveUmamiConfig({ websiteId: "abc", domains: " firework.sh " })
        ?.domains,
    ).toBe("firework.sh");
    expect(
      resolveUmamiConfig({ websiteId: "abc", domains: "  " }),
    ).not.toHaveProperty("domains");
  });
});
