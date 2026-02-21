import { describe, expect, it } from "vitest";
import { findStaleSourceIds } from "../src/sync/reconcile.js";

describe("findStaleSourceIds", () => {
  it("returns IDs that no longer exist in source", () => {
    const mapped = ["a", "b", "c"];
    const active = new Set(["a", "c", "d"]);

    expect(findStaleSourceIds(mapped, active)).toEqual(["b"]);
  });

  it("returns empty list when all mapped IDs are active", () => {
    const mapped = ["a", "b"];
    const active = new Set(["a", "b", "c"]);

    expect(findStaleSourceIds(mapped, active)).toEqual([]);
  });
});
