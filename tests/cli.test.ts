import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { entry, tempAgentDir } from "./helpers.js";

let dir: string;

async function run(...argv: string[]): Promise<{ out: string; code: number }> {
  let out = "";
  process.exitCode = 0;
  await main(argv, { write: (chunk: string) => (out += chunk) });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out, code };
}

function spend(cost: number): void {
  const line = JSON.stringify(entry(Date.now() - 60_000, cost));
  writeFileSync(join(dir, "budget-ledger.jsonl"), `${line}\n`, { flag: "a" });
}

beforeEach(() => {
  dir = tempAgentDir();
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("home view", () => {
  it("shows quota rows, windows and an explicit empty model list", async () => {
    const { out, code } = await run();
    expect(code).toBe(0);
    expect(out).toMatch(/^bin: /);
    expect(out).toContain("quota[1]{provider,scope,effectivePercentRemaining,spendPriority,runway");
    expect(out).toContain("azure-openai-responses,all_models,100,unknown,through_reset,estimated,5h,none");
    expect(out).toContain("models: 0 calls recorded in the weekly window");
    expect(out).not.toContain("attention");
  });

  it("flags an exhausted budget", async () => {
    spend(10.5);
    const { out } = await run();
    expect(out).toContain("exhausted_now");
    expect(out).toContain("budget_exhausted");
    expect(out).toContain("azure-openai-responses/gpt-5.6-sol,weekly,1,10.5");
  });

  it("reports a missing config as a structured error", async () => {
    process.env.PI_CODING_AGENT_DIR = join(dir, "nowhere");
    const { out, code } = await run();
    expect(code).toBe(1);
    expect(out).toContain("code: CONFIG_ERROR");
  });
});

describe("check", () => {
  it("allows a governed provider with budget left", async () => {
    spend(4);
    const { out, code } = await run("check", "--provider", "azure-openai-responses");
    expect(code).toBe(0);
    expect(out).toContain("budget: allowed");
    expect(out).toContain("percentRemaining: 60");
  });

  it("blocks with exit 1 once a window is exhausted", async () => {
    spend(10);
    const { out, code } = await run("check", "--provider", "azure-openai-responses");
    expect(code).toBe(1);
    expect(out).toContain("code: BUDGET_EXHAUSTED");
    expect(out).toContain("5h window spent 10 of 10");
  });

  it("passes providers without a budget", async () => {
    spend(100);
    const { out, code } = await run("check", "--provider", "anthropic");
    expect(code).toBe(0);
    expect(out).toContain("not governed");
  });

  it("rejects unknown and missing flags with exit 2", async () => {
    const unknown = await run("check", "--provder", "x");
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain("valid flags for `check`: --provider");
    expect((await run("check")).code).toBe(2);
  });
});

describe("record", () => {
  const args = ["--provider", "azure-openai-responses", "--model", "gpt-5.6-luna", "--response-id", "r1"];

  it("records once and treats a repeat as a no-op", async () => {
    expect((await run("record", ...args, "--cost", "0.25")).out).toContain("record: recorded");
    const again = await run("record", ...args, "--cost", "0.25");
    expect(again.code).toBe(0);
    expect(again.out).toContain("already recorded (no-op)");
  });

  it("skips ungoverned providers", async () => {
    const { out } = await run("record", "--provider", "anthropic", "--model", "m", "--response-id", "r", "--cost", "1");
    expect(out).toContain("skipped");
  });

  it.each(["", "abc", "-1"])("rejects cost %j", async (cost) => {
    const { code, out } = await run("record", ...args, `--cost=${cost}`);
    expect(code).toBe(2);
    expect(out).toContain("VALIDATION_ERROR");
  });
});
