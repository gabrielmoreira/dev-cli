import { describe, expect, it } from "bun:test";
import { mapWithConcurrency } from "../../src/mirror.ts";

/** Deferred promise for deterministic scheduling without wall-clock timers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    // Later items resolve first; results must still come back in input order.
    const gates = Array.from({ length: 4 }, () => deferred());
    const pending = mapWithConcurrency([0, 1, 2, 3], 4, async (i) => {
      await gates[i]!.promise;
      return `r${i}`;
    });
    for (const gate of [...gates].reverse()) gate.resolve();
    expect(await pending).toEqual(["r0", "r1", "r2", "r3"]);
  });

  it("never exceeds the concurrency limit", async () => {
    const gates = Array.from({ length: 6 }, () => deferred());
    let inFlight = 0;
    let peak = 0;
    const pending = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gates[i]!.promise;
      inFlight--;
      return i;
    });
    // Let microtasks run: exactly `limit` workers pick up items and stall.
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);
    for (const gate of gates) gate.resolve();
    await pending;
    expect(peak).toBe(2);
  });

  it("runs an empty list without spawning workers", async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });

  it("propagates worker rejections", async () => {
    const pending = mapWithConcurrency([1, 2, 3], 1, async (x) => {
      if (x === 2) throw new Error("boom");
      return x;
    });
    await expect(pending).rejects.toThrow("boom");
  });
});
