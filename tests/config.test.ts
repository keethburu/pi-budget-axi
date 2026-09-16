import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { agentDir, loadBudget, parseBudget } from "../src/config.js";
import { BUDGET } from "./helpers.js";

function configError(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AxiError);
    expect((error as AxiError).code).toBe("CONFIG_ERROR");
    return error as AxiError;
  }
  throw new Error("expected a CONFIG_ERROR");
}

describe("loadBudget", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-budget-config-"));

  it("reads a valid config", () => {
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify(BUDGET));
    expect(loadBudget(path)).toEqual(BUDGET);
  });

  it("names the missing file", () => {
    expect(configError(() => loadBudget(join(dir, "absent.json"))).message).toContain("not found");
  });

  it("rejects malformed JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{");
    expect(configError(() => loadBudget(path)).message).toContain("not valid JSON");
  });
});

describe("parseBudget", () => {
  const cases: Array<[string, unknown, string]> = [
    ["array top level", [], "top level"],
    ["empty currency", { ...BUDGET, currency: "" }, "currency"],
    ["no providers", { ...BUDGET, providers: [] }, "providers"],
    ["blank provider", { ...BUDGET, providers: [""] }, "providers"],
    ["no windows", { ...BUDGET, windows: [] }, "windows"],
    ["fractional seconds", { ...BUDGET, windows: [{ id: "x", seconds: 1.5, limit: 1 }] }, "seconds"],
    ["zero limit", { ...BUDGET, windows: [{ id: "x", seconds: 1, limit: 0 }] }, "limit"],
    ["missing id", { ...BUDGET, windows: [{ seconds: 1, limit: 1 }] }, "id"],
    [
      "duplicate ids",
      { ...BUDGET, windows: [{ id: "x", seconds: 1, limit: 1 }, { id: "x", seconds: 2, limit: 1 }] },
      "unique",
    ],
  ];
  it.each(cases)("rejects %s", (_name, raw, fragment) => {
    expect(configError(() => parseBudget(raw, "budget.json")).message).toContain(fragment);
  });
});

describe("agentDir", () => {
  it("follows PI_CODING_AGENT_DIR", () => {
    expect(agentDir({ PI_CODING_AGENT_DIR: "/x/agent" })).toBe("/x/agent");
  });
});
