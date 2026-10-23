# repro

Repro attempts to reproduce a website bug from a plain-English complaint and
returns an evidence report. The first workflow covers cart quantity and totals
on a local demo store, in Chromium.

Current state: **Spike B** — the demo store, a deterministic browser smoke
test, and the smallest working investigator (a model-driven tool loop with
code-enforced limits and evidence checks). There is no UI yet.

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
| `npm test` | Offline investigator tests. All model responses come from a scripted test double; no API calls. |
| `npm run trials` | The two initial live trials (same complaint, each store fixture). Needs `.env`. |
| `npm run investigate -- --url <store URL> [--expected "..."] "<complaint>"` | One live investigation. Needs `.env`. |
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

## Investigator (Spike B)

### Configuration

Copy `.env.example` to `.env` (git-ignored) and set:

- `REPRO_ANTHROPIC_API_KEY`: Repro's own key.
- `REPRO_MODEL`: the model ID to use.
- `REPRO_MAX_OUTPUT_TOKENS` (optional, default 8192): the per-response output-token limit.

The client is built with an explicit `apiKey` and `baseURL: https://api.anthropic.com`.
With both set, the SDK reads none of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
`ANTHROPIC_BASE_URL`, so a coding session's credentials or endpoint are never used
(covered by `test/config.test.ts`). Secret values are never printed or saved.

### How a run works

1. Code launches a fresh Chromium and context, opens the store URL and records
   the first observation (`obs-1`). All requests, navigations, WebSockets and
   popups outside the store's origin are blocked and logged.
2. The model gets the complaint, any supplied expected behavior, the tool
   descriptions and the observation. It never sees fixture names, expected
   verdicts, source code or the smoke test's answers. Page text is marked as
   untrusted data.
3. The model chooses actions with two browser tools:
   - `observe_page`: labeled values, clickable elements with IDs, accessibility outline.
   - `click_element(element_id)`: clicks an element from the latest observation,
     waits for the page to settle, and returns a new observation.

   Element IDs come from the page's own accessibility tree, so the model can
   only target elements the page actually exposed.
4. The model ends by calling `finish_investigation` with a verdict, the expected
   behavior it tested against, its assumptions, and evidence citations
   (`observation_id`, `label`, `value`).

### Rules enforced by code

| Rule | Behavior |
| --- | --- |
| 15 browser tool calls | Every non-report tool call counts, including invalid ones. Requesting a 16th ends the run as Inconclusive. |
| 90-second deadline | Covers browser launch, page actions and model requests. On expiry, the in-flight request is aborted, the browser closed, and the run is Inconclusive. |
| Model retries | SDK retries are off. Repro retries retryable failures (connection, 408, 409, 429, 5xx) at most twice, logs every attempt, and never waits past the deadline. |
| Evidence IDs | `obs-N`, `act-N`, `err-N` and `call-N` are assigned by code. Screenshots are `obs-N.png`. |
| Citation check | The cited observation must show exactly one field with that label, and its value must equal the quoted value. A matching number under another label fails. |
| Exercised scenario | Reproduced and Not reproduced both need citations of at least two labels, before and after a successful click, with at least one value changed. Otherwise the verdict is Inconclusive. |
| Failures | Refusal, a response cut off by the output-token limit, no report, a report malformed twice, an unreachable store, or an unexpected error each give Inconclusive with a reason. |

The model judges what the complaint means, which actions to take, what the
expected behavior is (unless supplied), and which verdict fits. Code can only
keep that verdict or downgrade it to Inconclusive. The record keeps the
supplied expectation separate from the model's tested expectation and its
listed assumptions.

### Run output

Each run is saved to `runs/<run-id>/`:

- `run.json`: verdict and reasons, end reason, model report, checked evidence,
  actions, observations (labeled values, clickable elements, accessibility
  outline), tool errors, blocked requests, model calls with token usage, total
  usage, duration and cleanup status.
- `transcript.json`: exactly what the model was sent and returned.
- `obs-N.png`: a screenshot per observation.

`npm run trials` saves both runs under `runs/trials-<timestamp>/` with opaque
run IDs. A `manifest.json` written after both runs maps run IDs to fixtures.
Two runs are an initial acceptance check, not a reliability claim.
