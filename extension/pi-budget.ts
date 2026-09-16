// pi extension: records every response's cost with pi-budget-axi and refuses to start or
// continue work on a governed provider once its budget is exhausted. It fails closed: when
// pi-budget-axi cannot be run or cannot record, the work is blocked as well.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BIN = process.env.PI_BUDGET_AXI_BIN || "pi-budget-axi";
const TIMEOUT_MS = 15_000;

interface Outcome {
  ok: boolean;
  text: string;
}

export default function piBudget(pi: ExtensionAPI): void {
  async function run(args: string[]): Promise<Outcome> {
    try {
      const result = await pi.exec(BIN, args, { timeout: TIMEOUT_MS });
      const text = (result.stdout || result.stderr).trim();
      return { ok: result.code === 0 && !result.killed, text: text || `${BIN} exited ${result.code}` };
    } catch (error) {
      return { ok: false, text: `could not run ${BIN}: ${(error as Error).message}` };
    }
  }

  function refuse(ctx: ExtensionContext, text: string): void {
    const message = `pi budget: ${text}`;
    if (ctx.hasUI) {
      ctx.ui.notify(message, "error");
    } else {
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }

  async function blocked(ctx: ExtensionContext): Promise<boolean> {
    const provider = ctx.model?.provider;
    if (!provider) {
      return false;
    }
    const outcome = await run(["check", "--provider", provider]);
    if (!outcome.ok) {
      refuse(ctx, outcome.text);
    }
    return !outcome.ok;
  }

  pi.on("input", async (_event, ctx) => ((await blocked(ctx)) ? { action: "handled" } : undefined));

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.usage.cost.total <= 0) {
      return;
    }
    const responseId = message.responseId ?? `${ctx.sessionManager.getSessionId()}:${message.timestamp}`;
    const outcome = await run([
      "record",
      "--provider",
      message.provider,
      "--model",
      message.model,
      "--response-id",
      responseId,
      "--cost",
      String(message.usage.cost.total),
    ]);
    if (!outcome.ok) {
      refuse(ctx, `spend was not recorded, stopping: ${outcome.text}`);
      ctx.abort();
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (await blocked(ctx)) {
      ctx.abort();
    }
  });
}
