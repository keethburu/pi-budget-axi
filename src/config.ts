import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";

/** A rolling window: at most `limit` may be spent in any span of `seconds`. */
export interface Window {
  id: string;
  seconds: number;
  limit: number;
}

/** Spend limits shared by every model of the listed pi providers. */
export interface Budget {
  currency: string;
  providers: string[];
  windows: Window[];
}

/** pi's config directory, honouring `PI_CODING_AGENT_DIR` the same way pi does. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "budget.json");
}

export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "budget-ledger.jsonl");
}

/** Read and validate the budget config, failing with an actionable CONFIG_ERROR. */
export function loadBudget(path: string): Budget {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw configError(path, "file not found");
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw configError(path, `not valid JSON (${(error as Error).message})`);
  }
  return parseBudget(raw, path);
}

export function parseBudget(raw: unknown, path: string): Budget {
  if (!isRecord(raw)) {
    throw configError(path, "top level must be an object");
  }
  const { currency, providers, windows } = raw;
  if (typeof currency !== "string" || currency === "") {
    throw configError(path, "`currency` must be a non-empty string");
  }
  if (!Array.isArray(providers) || providers.length === 0 || !providers.every(isNonEmptyString)) {
    throw configError(path, "`providers` must be a non-empty list of pi provider ids");
  }
  if (!Array.isArray(windows) || windows.length === 0) {
    throw configError(path, "`windows` must be a non-empty list");
  }
  const parsed = windows.map((window) => parseWindow(window, path));
  const ids = parsed.map((window) => window.id);
  if (new Set(ids).size !== ids.length) {
    throw configError(path, `window ids must be unique, got ${ids.join(",")}`);
  }
  return { currency, providers, windows: parsed };
}

function parseWindow(raw: unknown, path: string): Window {
  if (!isRecord(raw) || !isNonEmptyString(raw.id)) {
    throw configError(path, "each window needs a non-empty string `id`");
  }
  const { id, seconds, limit } = raw;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) {
    throw configError(path, `window ${id}: \`seconds\` must be a positive integer`);
  }
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    throw configError(path, `window ${id}: \`limit\` must be a positive number`);
  }
  return { id, seconds, limit };
}

function configError(path: string, reason: string): AxiError {
  return new AxiError(`Invalid budget config ${path}: ${reason}`, "CONFIG_ERROR", [
    `Fix ${path}; expected {"currency":"EUR","providers":["<pi provider id>"],` +
      `"windows":[{"id":"5h","seconds":18000,"limit":10}]}`,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
