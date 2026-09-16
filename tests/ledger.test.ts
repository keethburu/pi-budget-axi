import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { COMPACT_BYTES, appendEntry, parseLedger, readLedger } from "../src/ledger.js";
import { HOUR, NOW, entry } from "./helpers.js";

function ledgerFile(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-budget-ledger-")), "budget-ledger.jsonl");
}

describe("ledger", () => {
  it("treats a missing ledger as no spend", () => {
    expect(readLedger(ledgerFile())).toEqual([]);
  });

  it("records a response once", () => {
    const path = ledgerFile();
    const first = entry(NOW, 0.5);
    expect(appendEntry(path, first, HOUR)).toBe(true);
    expect(appendEntry(path, { ...first, ts: NOW + 1 }, HOUR)).toBe(false);
    expect(readLedger(path)).toEqual([first]);
  });

  it("counts a duplicated response id once and sorts by time", () => {
    const late = entry(NOW, 1);
    const early = entry(NOW - HOUR, 2);
    const text = [late, early, late].map((e) => JSON.stringify(e)).join("\n");
    expect(parseLedger(text, "ledger")).toEqual([early, late]);
  });

  it("reports the corrupt line number", () => {
    const text = `${JSON.stringify(entry(NOW, 1))}\n{"ts":1}\n`;
    expect(() => parseLedger(text, "ledger")).toThrow(/ledger:2/);
  });

  it("rejects negative and non-finite costs", () => {
    for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => appendEntry(ledgerFile(), entry(NOW, cost), HOUR)).toThrow(AxiError);
    }
  });

  it("drops entries older than the keep span once the ledger is large", () => {
    const path = ledgerFile();
    const old = entry(NOW - 2 * HOUR, 1);
    const padding = JSON.stringify(old).length + 1;
    const lines = Array.from({ length: Math.ceil(COMPACT_BYTES / padding) + 1 }, () =>
      JSON.stringify(entry(NOW - 2 * HOUR, 0)),
    );
    const recent = entry(NOW - HOUR / 2, 1);
    writeFileSync(path, `${[...lines, JSON.stringify(recent)].join("\n")}\n`);
    const newest = entry(NOW, 1);
    appendEntry(path, newest, HOUR);
    expect(readLedger(path)).toEqual([recent, newest]);
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("reclaims a stale lock left by a crashed writer", () => {
    const path = ledgerFile();
    mkdirSync(`${path}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    expect(appendEntry(path, entry(NOW, 1), HOUR)).toBe(true);
  });

  it("gives up on a lock that is held and fresh", () => {
    const path = ledgerFile();
    mkdirSync(`${path}.lock`);
    expect(() => appendEntry(path, entry(NOW, 1), HOUR)).toThrow(/Timed out/);
  }, 10_000);
});
