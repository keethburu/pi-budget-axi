import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/budget.js";
import { BUDGET, HOUR, NOW, entry } from "./helpers.js";

describe("evaluate", () => {
  it("reports a full budget with no spend", () => {
    const state = evaluate(BUDGET, [], NOW);
    expect(state.blocked).toBe(false);
    expect(state.windows.map((w) => [w.spent, w.percentRemaining, w.resetsAt])).toEqual([
      [0, 100, null],
      [0, 100, null],
    ]);
    expect(state.runway).toEqual({ kind: "through_reset" });
  });

  it("allows spend just under the limit and blocks at exactly the limit", () => {
    expect(evaluate(BUDGET, [entry(NOW - HOUR, 9.99)], NOW).blocked).toBe(false);
    const state = evaluate(BUDGET, [entry(NOW - HOUR, 10)], NOW);
    expect(state.blocked).toBe(true);
    expect(state.limiting.window.id).toBe("5h");
    expect(state.limiting.percentRemaining).toBe(0);
    expect(state.runway).toEqual({ kind: "exhausted_now", seconds: 0, windowId: "5h" });
  });

  it("drops spend at exactly the window edge from the 5h window but keeps it weekly", () => {
    const state = evaluate(BUDGET, [entry(NOW - 5 * HOUR, 10)], NOW);
    expect(state.windows[0]?.spent).toBe(0);
    expect(state.windows[1]?.spent).toBe(10);
    expect(state.blocked).toBe(false);
  });

  it("blocks on the weekly window even when the 5h window is clear", () => {
    const entries = [1, 2, 3, 4, 5, 6].map((day) => entry(NOW - day * 24 * HOUR, 9));
    const state = evaluate(BUDGET, entries, NOW);
    expect(state.blocked).toBe(true);
    expect(state.limiting.window.id).toBe("weekly");
  });

  it("ignores providers the budget does not govern and future entries", () => {
    const entries = [
      entry(NOW - HOUR, 20, { provider: "anthropic" }),
      entry(NOW + HOUR, 20),
    ];
    expect(evaluate(BUDGET, entries, NOW).blocked).toBe(false);
  });

  it("dates an exhausted window's reset to when enough old spend has left", () => {
    const entries = [entry(NOW - 4 * HOUR, 3), entry(NOW - 3 * HOUR, 4), entry(NOW - 2 * HOUR, 5)];
    const fiveHour = evaluate(BUDGET, entries, NOW).windows[0];
    // 12 spent: dropping 3 leaves 9, under the limit, so relief comes when the first entry leaves.
    expect(fiveHour?.resetsAt).toBe(NOW - 4 * HOUR + 5 * HOUR);
  });

  it("keeps a window exhausted while the remaining spend still equals the limit", () => {
    const entries = [entry(NOW - 4 * HOUR, 2), entry(NOW - 3 * HOUR, 10)];
    // Dropping the 2 leaves exactly 10, still at the limit, so relief waits for the 10 to leave.
    expect(evaluate(BUDGET, entries, NOW).windows[0]?.resetsAt).toBe(NOW - 3 * HOUR + 5 * HOUR);
  });

  it("dates an open window's reset to when its oldest spend leaves", () => {
    const entries = [entry(NOW - 4 * HOUR, 1), entry(NOW - 1 * HOUR, 1)];
    expect(evaluate(BUDGET, entries, NOW).windows[0]?.resetsAt).toBe(NOW + HOUR);
  });

  it("projects exhaustion from the last hour's burn rate", () => {
    const state = evaluate(BUDGET, [entry(NOW - HOUR / 2, 5)], NOW);
    // 5 per hour, 5 left in the 5h window: one hour of runway, before spend rolls off.
    expect(state.runway).toEqual({ kind: "projected_exhaustion", seconds: 3600, windowId: "5h" });
  });

  it("reports through_reset when spend rolls off faster than the burn exhausts any window", () => {
    // 0.25 per hour: the weekly window would last 199 h, longer than its 168 h span.
    expect(evaluate(BUDGET, [entry(NOW - HOUR / 2, 0.25)], NOW).runway).toEqual({
      kind: "through_reset",
    });
  });

  it("is never blocked at resetsAt when nothing new is spent", () => {
    const arbitraryEntry = fc.record({
      ageMs: fc.integer({ min: 0, max: 7 * 24 * HOUR }),
      cost: fc.double({ min: 0, max: 30, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(arbitraryEntry, { maxLength: 30 }), (raw) => {
        const entries = raw.map(({ ageMs, cost }) => entry(NOW - ageMs, cost));
        for (const window of evaluate(BUDGET, entries, NOW).windows) {
          if (window.exhausted && window.resetsAt !== null) {
            const later = evaluate(BUDGET, entries, window.resetsAt);
            const same = later.windows.find((w) => w.window.id === window.window.id);
            expect(same?.exhausted).toBe(false);
          }
        }
      }),
    );
  });
});
