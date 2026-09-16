# pi-budget-axi

Caps what [pi](https://github.com/earendil-works/pi) may spend on a model provider over
rolling time windows, and reports the state in the same `quota[]` shape as
[quota-axi](https://github.com/kunchenguid/quota-axi). It is meant for providers billed per
token where the account itself offers no usable budget controls, such as an Azure OpenAI
deployment behind pi's `azure-openai-responses` provider.

The CLI follows the [AXI](https://github.com/kunchenguid/axi) principles and is built on
[`axi-sdk-js`](https://github.com/kunchenguid/axi/tree/main/packages/axi-sdk-js).

## How it works

- A pi extension (`extension/pi-budget.ts`) records the cost of every completed response
  with `pi-budget-axi record`. The costs are pi's own estimates from its model price list
  (`~/.pi/agent/models.json` overrides), in the currency those prices use.
- Before pi accepts a prompt, and after every turn, the extension runs
  `pi-budget-axi check`. When a governed provider is over budget, pi refuses the prompt or
  aborts the running agent. If `pi-budget-axi` cannot run or cannot record, the extension
  blocks as well.
- Each window is rolling: spend within the trailing span must stay under the limit. A
  rolling window has no reset boundary to burst across, unlike a window that resets in full
  at a fixed time.
- The ledger is `budget-ledger.jsonl` next to the config. Each response id is counted
  once, because forked pi sessions replay history. Once the file passes 2 MB, entries older
  than the longest window are dropped.

## Setup

```sh
npm install
npm run build
npm install -g .
ln -s "$PWD/extension/pi-budget.ts" ~/.pi/agent/extensions/pi-budget.ts
```

`~/.pi/agent/budget.json` (or `$PI_CODING_AGENT_DIR/budget.json`):

```json
{
  "currency": "EUR",
  "providers": ["azure-openai-responses"],
  "windows": [
    { "id": "5h", "seconds": 18000, "limit": 10 },
    { "id": "weekly", "seconds": 604800, "limit": 50 }
  ]
}
```

All listed providers share the limits. Providers that are not listed are not recorded or
blocked. The extension finds the CLI on `PATH`; set `PI_BUDGET_AXI_BIN` to use another path.

## Usage

```sh
pi-budget-axi                     # report: quota rows, windows, spend by model
pi-budget-axi check --provider azure-openai-responses   # exit 0 allowed, 1 blocked
pi-budget-axi record --provider <id> --model <id> --response-id <id> --cost <n>
pi-budget-axi <command> --help
```

In the report, `resetsAt` is when spend next leaves the window. For an exhausted window it
is when enough spend has left for the window to fall back under its limit. `runway`
projects the last hour's burn rate. It reads `through_reset` when old spend leaves the
window before that rate would exhaust it. `spendPriority` is always `unknown`.

## Limits

- One call can overshoot a limit, because its cost is known only after it completes. A
  long-context request can cost several euros on its own.
- Only pi calls made with the extension loaded are counted. `pi --no-extensions`, other
  tools that use the same Azure key, and other machines are not counted.
- The costs are estimates from the price list. They are not Azure's billing figures.

## Development

```sh
npm run typecheck
npm test
```
