# repro

Repro attempts to reproduce a website bug from a plain-English complaint and
returns an evidence report. The first workflow covers cart quantity and totals
on a local demo store, in Chromium.

Current state: **Spike A** — the demo store and a deterministic browser smoke
test. There is no model loop or UI yet, and nothing here calls a model.

## Setup on a fresh checkout

Requires Node 22.18 or newer (TypeScript files run directly via Node's type
stripping).

```sh
npm ci              # installs the pinned playwright@1.63.0 from package-lock.json
npm run browsers    # downloads the Chromium build that playwright@1.63.0 expects
```

`npm run browsers` runs `playwright install chromium` from the project's own
Playwright, so the browser always matches the pinned version (Chromium 153,
Playwright build 1243) regardless of any global install. On a bare Linux
machine, also install system libraries once with
`npx playwright install-deps chromium`. If browsers live in a shared location,
set `PLAYWRIGHT_BROWSERS_PATH` for both commands.

## Commands

| Command | What it does |
| --- | --- |
| `npm run smoke` | Runs the cart flow against both store fixtures and checks the labeled observations. Exits nonzero if any check fails. |
| `npm run typecheck` | Type-checks all TypeScript. |
| `REPRO_STORE_FIXTURE=correct npm run store` | Serves the demo store at http://127.0.0.1:4173/ (`PORT` to change). Use `faulty` for the buggy version. |

Each smoke run writes to `runs/smoke-<timestamp>/` (git-ignored):
`<fixture>/before.png`, `<fixture>/after-increase.png`,
`<fixture>/observations.json` and `summary.json`.

## Demo store

One cart: Ceramic Mug, unit price $20.00, quantity 1, total $20.00, and an
"Increase quantity" button. No tax, discounts or shipping.

The fixture is chosen by server configuration (`REPRO_STORE_FIXTURE`, or the
argument to `createStoreServer`). Both fixtures serve byte-identical HTML and
JavaScript at the same route, and the pricing API response carries no fixture
marker. They differ only in how the server computes the total:

- `correct`: total = unit price × quantity → $40.00 after one click.
- `faulty`: total ignores quantity → stays $20.00 after one click.

## How observations work

`src/observe.ts` reads only what a browser user can see:

- **Accessibility snapshot** (`page.ariaSnapshot()` / `page.ariaSnapshotJSON()`,
  Playwright's public API): a text outline of the page as a screen reader sees it.
- **Screenshot** of the full page.

Values are extracted as `Label: value` pairs from single nodes of the
accessibility tree, together with the path to that node. A check on "Total"
reads only the field labeled `Total`. A label that is missing or appears more
than once is reported as a failure rather than guessed.

After clicking, the smoke test waits for **Quantity** to change and for
network activity to stop. It never waits for the total, so a total that stays
wrong is recorded as an observation instead of causing a timeout.

Every run uses a new browser process and context, so no cookies, storage or
cache carry over. The browser and server are closed whether the run passes or
fails.

## Planned for Spike B (not built)

- Investigator limits: 15 browser tool calls and 90 seconds per run, plus an
  output-token limit you can configure.
- Credentials: Repro reads its own API key and sets the Anthropic API base URL
  explicitly. The SDK falls back to `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`
  from the environment, so the client is constructed with explicit values so it
  never inherits a coding session's settings.
- Repeated runs per fixture are an initial acceptance check, not a general
  reliability claim.
