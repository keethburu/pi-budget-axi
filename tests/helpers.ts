import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Budget } from "../src/config.js";
import type { Entry } from "../src/ledger.js";

export const HOUR = 3_600_000;
export const NOW = Date.parse("2026-09-17T12:00:00Z");

export const BUDGET: Budget = {
  currency: "EUR",
  providers: ["azure-openai-responses"],
  windows: [
    { id: "5h", seconds: 18_000, limit: 10 },
    { id: "weekly", seconds: 604_800, limit: 50 },
  ],
};

let counter = 0;

export function entry(ts: number, cost: number, overrides: Partial<Entry> = {}): Entry {
  counter += 1;
  return {
    ts,
    provider: "azure-openai-responses",
    model: "gpt-5.6-sol",
    responseId: `resp_${counter}`,
    cost,
    ...overrides,
  };
}

export function tempAgentDir(budget: unknown = BUDGET): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-budget-axi-"));
  writeFileSync(join(dir, "budget.json"), JSON.stringify(budget));
  return dir;
}
