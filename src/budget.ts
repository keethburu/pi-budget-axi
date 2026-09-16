import type { Budget, Window } from "./config.js";
import type { Entry } from "./ledger.js";

/** The burn rate for runway projection is measured over this trailing span. */
export const BURN_MS = 3_600_000;

/**
 * Spend inside one rolling window. `resetsAt` (Unix ms) is when spend next leaves the
 * window; while the window is exhausted it is when enough has left to fall under the limit.
 */
export interface WindowState {
  window: Window;
  spent: number;
  resetsAt: number | null;
  exhausted: boolean;
  percentRemaining: number;
}

export interface Runway {
  kind: "exhausted_now" | "projected_exhaustion" | "through_reset";
  /** Seconds of usable spend left; set unless `kind` is through_reset. */
  seconds?: number;
  windowId?: string;
}

export interface BudgetState {
  windows: WindowState[];
  limiting: WindowState;
  blocked: boolean;
  runway: Runway;
}

/** Evaluate every window of `budget` at `now` (Unix ms) from ledger entries. */
export function evaluate(budget: Budget, entries: Entry[], now: number): BudgetState {
  const relevant = entries
    .filter((entry) => budget.providers.includes(entry.provider) && entry.ts <= now)
    .sort((a, b) => a.ts - b.ts);
  const windows = budget.windows.map((window) => windowState(window, relevant, now));
  const limiting = windows.reduce((tightest, state) =>
    rank(state) < rank(tightest) ? state : tightest,
  );
  const burnPerMs = sumCost(relevant.filter((entry) => entry.ts > now - BURN_MS)) / BURN_MS;
  return {
    windows,
    limiting,
    blocked: windows.some((state) => state.exhausted),
    runway: runway(windows, burnPerMs),
  };
}

function windowState(window: Window, entries: Entry[], now: number): WindowState {
  const windowMs = window.seconds * 1000;
  const inside = entries.filter((entry) => entry.ts > now - windowMs);
  const spent = sumCost(inside);
  const exhausted = spent >= window.limit;
  const remaining = Math.max(0, window.limit - spent);
  return {
    window,
    spent,
    resetsAt: resetsAt(window, inside, spent),
    exhausted,
    percentRemaining: exhausted ? 0 : Math.floor((remaining / window.limit) * 100),
  };
}

function resetsAt(window: Window, inside: Entry[], spent: number): number | null {
  const windowMs = window.seconds * 1000;
  let left = spent;
  // Walk the oldest spend out of the window until the rest is under the limit.
  for (const entry of inside) {
    left -= entry.cost;
    if (left < window.limit) {
      return entry.ts + windowMs;
    }
  }
  return null;
}

function runway(windows: WindowState[], burnPerMs: number): Runway {
  const exhausted = windows.find((state) => state.exhausted);
  if (exhausted) {
    return { kind: "exhausted_now", seconds: 0, windowId: exhausted.window.id };
  }
  let best: Runway = { kind: "through_reset" };
  if (burnPerMs <= 0) {
    return best;
  }
  for (const state of windows) {
    const ms = (state.window.limit - state.spent) / burnPerMs;
    // At the current burn, spend older than the window span rolls off before this point.
    if (ms < state.window.seconds * 1000 && (best.seconds === undefined || ms / 1000 < best.seconds)) {
      best = { kind: "projected_exhaustion", seconds: Math.floor(ms / 1000), windowId: state.window.id };
    }
  }
  return best;
}

function rank(state: WindowState): number {
  return state.exhausted ? -1 : state.percentRemaining;
}

function sumCost(entries: Entry[]): number {
  return entries.reduce((total, entry) => total + entry.cost, 0);
}
