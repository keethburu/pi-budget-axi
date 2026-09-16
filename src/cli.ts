import { parseArgs } from "node:util";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { evaluate, type BudgetState } from "./budget.js";
import { configPath, ledgerPath, loadBudget, type Budget } from "./config.js";
import { appendEntry, readLedger, type Entry } from "./ledger.js";
import { VERSION } from "./version.js";

type AxiStructuredOutput = Record<string, unknown>;

const BIN = "pi-budget-axi";
const DESCRIPTION = "Enforce and report a rolling spend budget on pi model providers";

const TOP_LEVEL_HELP = `usage: ${BIN} [check|record] [flags]
commands[3]:
  (none)=budget report, check, record
output:
  Default TOON reports spend per rolling window in quota-axi's quota[] shape. Costs are pi's
  estimates from its model price list, in the configured currency.
config:
  ~/.pi/agent/budget.json (or $PI_CODING_AGENT_DIR/budget.json); ledger budget-ledger.jsonl beside it
windows:
  Rolling: spend in the trailing span must stay under the limit. resetsAt is when spend next
  leaves the window; for an exhausted window, when enough has left to fall under the limit.
  runway projects the last hour's burn rate; through_reset means old spend rolls off first.
exit codes:
  0 ok or allowed, 1 blocked or error, 2 usage error
examples:
  ${BIN}
  ${BIN} check --provider azure-openai-responses
  ${BIN} record --provider azure-openai-responses --model gpt-5.6-sol --response-id resp_1 --cost 0.42
`;

const COMMAND_HELP: Record<string, string> = {
  check: `usage: ${BIN} check --provider <pi provider id>
description: Exit 0 when a call to this provider is within budget, 1 with an error when blocked
flags[1]:
  --provider <id> (required)
notes:
  A provider not listed in budget.json is not governed and always passes.
examples:
  ${BIN} check --provider azure-openai-responses
`,
  record: `usage: ${BIN} record --provider <id> --model <id> --response-id <id> --cost <number>
description: Record the cost of one completed provider response; repeating a response id is a no-op
flags[4]:
  --provider <id> (required), --model <id> (required), --response-id <id> (required),
  --cost <number in budget currency> (required)
notes:
  Responses from providers not listed in budget.json are not recorded.
examples:
  ${BIN} record --provider azure-openai-responses --model gpt-5.6-luna --response-id resp_1 --cost 0.0023
`,
};

export async function main(
  argv: string[] = process.argv.slice(2),
  stdout: { write: (chunk: string) => unknown } = process.stdout,
): Promise<void> {
  await runAxiCli({
    stdout,
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: (command) => COMMAND_HELP[command],
    home: () => homeView(Date.now()),
    commands: {
      check: (args) => checkCommand(args, Date.now()),
      record: (args) => recordCommand(args, Date.now()),
    },
  });
}

export function homeView(now: number): AxiStructuredOutput {
  const budget = loadBudget(configPath());
  const entries = readLedger(ledgerPath());
  const state = evaluate(budget, entries, now);
  return {
    generatedAt: iso(now),
    currency: budget.currency,
    quota: budget.providers.map((provider) => quotaRow(provider, state)),
    ...exhaustionBlock(budget, state, now),
    windows: state.windows.map((window) => ({
      id: window.window.id,
      spent: money(window.spent),
      limit: window.window.limit,
      percentRemaining: window.percentRemaining,
      resetsAt: window.resetsAt === null ? "none" : iso(window.resetsAt),
    })),
    models: modelSpend(budget, entries, now),
    ...(state.blocked ? { attention: [blockedAttention(budget, state)] } : {}),
    help: [
      `Run \`${BIN} check --provider <id>\` for a pass/block answer before starting pi work`,
      `Run \`${BIN} --help\` for how resetsAt, runway and the ledger work`,
    ],
  };
}

function checkCommand(args: string[], now: number): AxiStructuredOutput {
  const { provider } = flags(args, "check", ["provider"]);
  const budget = loadBudget(configPath());
  if (!budget.providers.includes(provider)) {
    return { budget: `not governed (provider ${provider} has no budget)`, provider };
  }
  const state = evaluate(budget, readLedger(ledgerPath()), now);
  if (state.blocked) {
    throw new AxiError(blockedMessage(budget, state), "BUDGET_EXHAUSTED", [
      `Wait until ${resetText(state)}, or raise the limit in ${configPath()}`,
      `Run \`${BIN}\` to see spend by window and model`,
    ]);
  }
  return {
    budget: "allowed",
    provider,
    limitedBy: state.limiting.window.id,
    percentRemaining: state.limiting.percentRemaining,
  };
}

function recordCommand(args: string[], now: number): AxiStructuredOutput {
  const values = flags(args, "record", ["provider", "model", "response-id", "cost"]);
  const cost = Number(values.cost);
  if (values.cost.trim() === "" || !Number.isFinite(cost) || cost < 0) {
    throw usage(`--cost must be a number >= 0, got ${values.cost}`, "record");
  }
  const budget = loadBudget(configPath());
  if (!budget.providers.includes(values.provider)) {
    return { record: `skipped (provider ${values.provider} has no budget)` };
  }
  const entry: Entry = {
    ts: now,
    provider: values.provider,
    model: values.model,
    responseId: values["response-id"],
    cost,
  };
  const longestMs = Math.max(...budget.windows.map((window) => window.seconds)) * 1000;
  const added = appendEntry(ledgerPath(), entry, longestMs);
  return {
    record: added ? "recorded" : "already recorded (no-op)",
    responseId: entry.responseId,
    cost,
  };
}

function quotaRow(provider: string, state: BudgetState): AxiStructuredOutput {
  return {
    provider,
    scope: "all_models",
    effectivePercentRemaining: state.limiting.percentRemaining,
    spendPriority: "unknown",
    runway: state.runway.kind,
    confidence: "estimated",
    limitedBy: state.limiting.window.id,
    resetsAt: state.limiting.resetsAt === null ? "none" : iso(state.limiting.resetsAt),
  };
}

function exhaustionBlock(budget: Budget, state: BudgetState, now: number): AxiStructuredOutput {
  const { runway } = state;
  if (runway.seconds === undefined) {
    return {};
  }
  const seconds = runway.seconds;
  return {
    exhaustion: budget.providers.map((provider) => ({
      provider,
      scope: "all_models",
      usableRunwaySeconds: seconds,
      projectedExhaustedAt: iso(now + seconds * 1000),
      limitingWindowId: runway.windowId ?? "unknown",
    })),
  };
}

function modelSpend(budget: Budget, entries: Entry[], now: number): AxiStructuredOutput[] | string {
  const longest = budget.windows.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  const totals = new Map<string, { calls: number; spent: number }>();
  for (const entry of entries) {
    if (!budget.providers.includes(entry.provider) || entry.ts <= now - longest.seconds * 1000) {
      continue;
    }
    const key = `${entry.provider}/${entry.model}`;
    const total = totals.get(key) ?? { calls: 0, spent: 0 };
    totals.set(key, { calls: total.calls + 1, spent: total.spent + entry.cost });
  }
  if (totals.size === 0) {
    return `0 calls recorded in the ${longest.id} window`;
  }
  return [...totals]
    .sort(([, a], [, b]) => b.spent - a.spent)
    .map(([model, total]) => ({ model, window: longest.id, calls: total.calls, spent: money(total.spent) }));
}

function blockedAttention(budget: Budget, state: BudgetState): AxiStructuredOutput {
  return {
    provider: budget.providers.join("+"),
    kind: "budget_exhausted",
    detail: blockedMessage(budget, state),
    remedy: `wait until ${resetText(state)}`,
  };
}

function blockedMessage(budget: Budget, state: BudgetState): string {
  const parts = state.windows
    .filter((window) => window.exhausted)
    .map((window) => `${window.window.id} window spent ${money(window.spent)} of ${window.window.limit}`);
  return `pi budget exhausted for ${budget.providers.join(", ")}: ${parts.join("; ")} ${budget.currency}`;
}

// A call is allowed again only once every exhausted window has fallen back under its limit.
function resetText(state: BudgetState): string {
  const times = state.windows
    .filter((window) => window.exhausted && window.resetsAt !== null)
    .map((window) => window.resetsAt as number);
  return times.length === 0 ? "spend leaves the window" : iso(Math.max(...times));
}

function flags<N extends string>(args: string[], command: string, names: N[]): Record<N, string> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    throw usage((error as Error).message, command, names);
  }
  const values = {} as Record<N, string>;
  for (const name of names) {
    const value = parsed.values[name];
    if (typeof value !== "string" || value === "") {
      throw usage(`--${name} is required`, command, names);
    }
    values[name] = value;
  }
  return values;
}

function usage(message: string, command: string, names: string[] = []): AxiError {
  const valid = names.length === 0 ? "none" : names.map((name) => `--${name}`).join(", ");
  return new AxiError(message, "VALIDATION_ERROR", [
    `valid flags for \`${command}\`: ${valid} (--help always allowed)`,
  ]);
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
