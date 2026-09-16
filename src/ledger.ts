import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { AxiError } from "axi-sdk-js";

/** The cost of one completed provider response. `ts` is Unix milliseconds. */
export interface Entry {
  ts: number;
  provider: string;
  model: string;
  responseId: string;
  cost: number;
}

/** Past this size, `append` drops entries no window can still see. */
export const COMPACT_BYTES = 2_000_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/**
 * Read every entry, counting each response id once (forked pi sessions replay history),
 * sorted by timestamp. A missing ledger means nothing has been spent.
 */
export function readLedger(path: string): Entry[] {
  if (!existsSync(path)) {
    return [];
  }
  return parseLedger(readFileSync(path, "utf8"), path);
}

export function parseLedger(text: string, path: string): Entry[] {
  const byId = new Map<string, Entry>();
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }
    const entry = parseLine(line, `${path}:${index + 1}`);
    if (!byId.has(entry.responseId)) {
      byId.set(entry.responseId, entry);
    }
  });
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Append an entry unless its response id is already recorded.
 *
 * @param keepMs how far back compaction must keep entries (the longest window)
 * @returns false when the response id was already present
 */
export function appendEntry(path: string, entry: Entry, keepMs: number): boolean {
  if (!Number.isFinite(entry.cost) || entry.cost < 0) {
    throw new AxiError(`Cost must be a finite number >= 0, got ${entry.cost}`, "VALIDATION_ERROR");
  }
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, () => {
    const existing = readLedger(path);
    if (existing.some((known) => known.responseId === entry.responseId)) {
      return false;
    }
    if (existsSync(path) && statSync(path).size > COMPACT_BYTES) {
      const kept = existing.filter((known) => known.ts >= entry.ts - keepMs);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, kept.map((known) => `${JSON.stringify(known)}\n`).join(""));
      renameSync(tmp, path);
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    return true;
  });
}

function parseLine(line: string, where: string): Entry {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw ledgerError(where, "not JSON");
  }
  const value = raw as Partial<Record<keyof Entry, unknown>>;
  const { ts, provider, model, responseId, cost } = value;
  if (
    typeof ts !== "number" ||
    typeof provider !== "string" ||
    typeof model !== "string" ||
    typeof responseId !== "string" ||
    typeof cost !== "number"
  ) {
    throw ledgerError(where, "expected {ts,provider,model,responseId,cost}");
  }
  return { ts, provider, model, responseId, cost };
}

function ledgerError(where: string, reason: string): AxiError {
  return new AxiError(`Corrupt ledger line ${where}: ${reason}`, "LEDGER_ERROR", [
    `Fix or delete line ${where}; every other line must stay intact`,
  ]);
}

// A directory lock, because Node has no flock. Several pi processes record concurrently.
function withLock<T>(path: string, action: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryLock(lock)) {
    if (Date.now() > deadline) {
      throw new AxiError(`Timed out waiting for ledger lock ${lock}`, "LEDGER_LOCKED", [
        `If no pi-budget-axi process is running, remove the directory ${lock}`,
      ]);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try {
    return action();
  } finally {
    rmdirSync(lock);
  }
}

function tryLock(lock: string): boolean {
  try {
    mkdirSync(lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  // A crashed holder leaves the directory behind; reclaim it once it is clearly stale.
  try {
    if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
      rmdirSync(lock);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return false;
}
