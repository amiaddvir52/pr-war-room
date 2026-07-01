import { describe, it, expect } from "vitest";
import { selectBanner } from "../../src/ui/banner.js";

describe("selectBanner", () => {
  it("returns the wide wordmark for a wide terminal", () => {
    const art = selectBanner(120);
    expect(art).not.toBeNull();
    expect(art!.split("\n").length).toBeGreaterThan(3);
  });

  it("returns the compact wordmark for a medium terminal", () => {
    const art = selectBanner(60);
    expect(art).not.toBeNull();
  });

  it("returns null for a narrow terminal or non-TTY (undefined columns)", () => {
    expect(selectBanner(20)).toBeNull();
    expect(selectBanner(undefined)).toBeNull();
  });

  it("uses different art for wide vs medium terminals", () => {
    expect(selectBanner(120)).not.toBe(selectBanner(60));
  });
});
