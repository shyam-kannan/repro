# repro

Repro attempts to reproduce a website bug from a plain-English complaint and
returns an evidence report. The first workflow covers cart quantity and totals
on a local demo store, in Chromium.

Current state: the demo store, a deterministic browser smoke test, the
smallest working investigator (a model-driven tool loop with code-enforced
limits and evidence checks), and a minimal local web UI on top of it.

**Feasibility and early consistency, not proven reliability.** Measured so far
with `claude-haiku-5-5`, all against one controlled store with one bug:

- 4 early live runs (2 from `npm run trials`, 2 through the UI): all matched.
- The 8-case evaluation (`npm run eval`, see
  [docs/evaluation-2026-10-24.md](docs/evaluation-2026-10-24.md)): **8/8
  matched**. That is 3/3 Not reproduced on the correct store, 3/3 Reproduced
  on the faulty store, Inconclusive with the store down (decided by code, no
  model call), and Inconclusive for an unrelated search complaint. Every
  citation matched its observation and screenshot.

- The `faulty-from-3` follow-up (`npm run eval -- faulty-from-3`): **4/4
  matched**. Three runs on a store whose total breaks only from quantity 3
  were all Reproduced, and the correct-store control was Not reproduced.

**Known limitation: exploration depth.** The investigator decides for itself
when to stop clicking. In 4 of the 9 live runs that saw a correct total after
the first click, it stopped there, which would miss a bug starting at
quantity 3. No run went past quantity 3. Also, Repro's code does not check
that a verdict agrees with the cited values. An offline test shows it keeps a
"Not reproduced" claim whose own evidence shows a wrong total. Details are in
the evaluation notes.

That is a small sample of simple bugs with one complaint phrasing, and it
cannot rule out a meaningful error rate. More runs and harder bugs are needed
before any reliability claim.

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

## Quick start (web UI)

```sh
npm ci
cp .env.example .env        # then set REPRO_ANTHROPIC_API_KEY and REPRO_MODEL
REPRO_STORE_FIXTURE=faulty npm start
```

`npm start` prints:

```
Demo store:  http://127.0.0.1:4173/  (fixture: faulty)
Repro:       http://127.0.0.1:4300/
```

Open the Repro URL, pick the example complaint (or type one), and click
**Investigate**. Stop with Ctrl+C.

- **Fixture selection:** `REPRO_STORE_FIXTURE=correct` or `faulty` (default
  `faulty`), chosen once at startup and printed only in the terminal. Restart
  to switch. The UI, the run records and the investigator never receive it.
- **Ports:** `REPRO_PORT` (default 4300) and `STORE_PORT` (default 4173). Both
  servers listen on 127.0.0.1 only.
- **Output-token cap for one session:** `REPRO_MAX_OUTPUT_TOKENS=2048 npm start`
  overrides the value in `.env`.
- Without `REPRO_ANTHROPIC_API_KEY` and `REPRO_MODEL`, the UI still loads,
  names the missing variables (never their values) and refuses to start runs.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Demo store plus the Repro web UI (see Quick start). Needs `.env` to investigate. |
| `npm test` | Offline tests: investigator, server API and the browser flow through the UI. All model responses come from a scripted test double; no API calls. |
| `npm run eval` | The 8-case live evaluation (see below). Needs `.env`. Exits nonzero on any mismatch. |
| `npm run eval -- faulty-from-3` | Three live runs on the faulty-from-3 store plus one correct-store control. |
| `npm run eval -- --summarize runs/eval-<...>` | Rebuilds an evaluation summary from saved run records. No model calls, no credentials needed. |
| `npm run trials` | The two initial live trials (same complaint, each store fixture). Needs `.env`. |
| `npm run investigate -- --url <store URL> [--expected "..."] "<complaint>"` | One live investigation. Needs `.env`. |
| `npm run smoke` | Runs the cart flow (three increases) against every store fixture and checks the labeled observations. Exits nonzero if any check fails. |
| `npm run typecheck` | Type-checks all TypeScript. |
| `REPRO_STORE_FIXTURE=correct npm run store` | Serves the demo store at http://127.0.0.1:4173/ (`PORT` to change). Use `faulty` for the buggy version. |

`npm run smoke` clicks "Increase quantity" three times per fixture and checks
the total after each click. Each smoke run writes to
`runs/smoke-<timestamp>/` (git-ignored): `<fixture>/before.png`,
`<fixture>/after-increase-1.png` … `-3.png`,
`<fixture>/observations.json` and `summary.json`.

## Demo store

One cart: Ceramic Mug, unit price $20.00, quantity 1, total $20.00, and an
"Increase quantity" button. No tax, discounts or shipping.

The fixture is chosen by server configuration (`REPRO_STORE_FIXTURE`, or the
argument to `createStoreServer`). All fixtures serve byte-identical HTML and
JavaScript at the same route, and the pricing API response carries no fixture
marker. They differ only in how the server computes the total:

- `correct`: total = unit price × quantity → $40.00 after one click.
- `faulty`: total ignores quantity → stays $20.00 after one click.
- `faulty-from-3`: correct up to quantity 2 ($40.00), then the total stops
  growing → $40.00 at quantity 3 and above. Indistinguishable from `correct`
  until the second click.

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

## Web UI

### How it connects

`npm start` (`scripts/start.ts`) starts the demo store and `app/server.ts`, a
plain `node:http` server with static HTML, CSS and JavaScript in `app/public/`.
The server holds the API key and calls the unchanged `investigate()`; the
browser page never sees credentials or talks to the model.

`investigate()` takes an optional `onEvent` listener. It is called at the
points where the run already records something: an action or observation,
a model request starting and finishing (attempt, stop reason, token counts,
error), the model's chosen browser tool and target, a tool error, the report
being submitted (proposed verdict, number of citations), and the final
verdict. Model text and reasoning are never forwarded. A listener that throws
is ignored, so progress reporting cannot change a run. Limits, origin
blocking, citation checks and verdict downgrade rules are untouched.

### Endpoints

| Route | Purpose |
| --- | --- |
| `GET /`, `GET /runs/<run-id>` | The page (a run URL can be reloaded or shared locally). |
| `GET /api/status` | Configured or not (variable names only), model, limits, store URL, active run. |
| `POST /api/runs` | Start a run: `{ "complaint": "...", "expectedBehavior": "..." }`. 409 while another run is active. |
| `GET /api/runs` | The 20 most recent UI runs. |
| `GET /api/runs/<run-id>` | Status, recorded events and the saved record (filesystem path removed). |
| `GET /api/runs/<run-id>/events` | Server-sent events: replays recorded events, then streams live ones until the run ends. |
| `GET /api/runs/<run-id>/obs-N.png` | A screenshot. |

Nothing else is served. Run IDs must match `run-[0-9a-f]{8}` and screenshots
`obs-N.png`, so `.env`, source files, `transcript.json` and arbitrary paths are
unreachable. Requests with another `Host` header are refused (DNS rebinding),
`POST /api/runs` refuses cross-origin requests, and pages are served with a
strict Content-Security-Policy. All complaint text, page values and model
output are inserted as text, never as HTML.

The investigator's Chromium is restricted to the store's origin, so it cannot
reach the Repro UI (a different port, so a different origin).

### Runs, failures and interruptions

UI runs are saved under `runs/ui/<run-id>/` (git-ignored) with the usual
`run.json`, `transcript.json` and `obs-N.png`, plus:

- `status.json`: `running`, `finished`, `failed` or `interrupted`, with the verdict or error.
- `events.jsonl`: the progress events as they were recorded.

Only one investigation runs at a time; the form is disabled and the API
answers 409 with the active run's link. A run whose investigation throws is
marked `failed`. If it outlives its 90-second deadline by 30 seconds, a
watchdog marks it `failed`, and the lock is held until the browser has
actually closed. Stopping the server mid-run marks it `interrupted`, and a
run found `running` at startup is marked `interrupted`. The page stops its
spinner on any final status, and also if it loses contact with the server.

The report labels where each failure came from: model API failure, browser
failure, time or tool-call limit, model mistake (refusal, no report,
malformed report, output-token limit), or evidence validation downgrading the
model's verdict.

### Verifying

```sh
npm run typecheck
npm test        # includes test/app.test.ts: API, live progress, reopen, overlap, failures, path checks
npm run smoke
```

`test/app.test.ts` drives the real UI in Chromium against the faulty store with
a **scripted test double** in place of the model. Those run pages show a
"scripted test double, not a real model" banner. They verify the UI and
pipeline, not model behavior. A live check means `npm start` with a configured
key, then one Investigate click per fixture.

### Limitations

- One complaint, one bug and one store. Live results show feasibility, not reliability.
- One run at a time and one fixture per server start.
- No authentication, intended for localhost use only. Anyone who can reach
  127.0.0.1 on this machine can start runs, which spend API credit.
- Run history is a directory listing (latest 20). There is no deletion,
  search or comparison between runs.
- Progress shows recorded events and elapsed time only. There are no
  percentages, because the number of steps a run needs is not known in advance.

## Evaluation

```sh
REPRO_MAX_OUTPUT_TOKENS=2048 npm run eval
```

This runs eight live investigations, each once, with the configured model,
the unchanged prompts and the standard limits:

| Case | Store | Complaint | Expected |
| --- | --- | --- | --- |
| correct-1..3 | correct | the cart complaint | Not reproduced in this run |
| faulty-1..3 | faulty | the cart complaint | Reproduced |
| store-unavailable | nothing listening | the cart complaint | Inconclusive |
| unrelated-complaint | correct | "Searching for headphones returns no results." | Inconclusive |

The expected verdicts and store setups live only in `scripts/eval.ts`. The
investigator receives the complaint and a URL, and the run IDs are opaque.

Before each run, `scripts/harness.ts` (shared with `npm run trials`) starts a
fresh store on an OS-assigned port, so ports cannot collide. It then confirms
which fixture is answering by pricing 2 and then 3 mugs through the store API,
outside the investigator's browser: ($40, $60) means correct, ($20, $20)
faulty and ($40, $40) faulty-from-3. Quantity 2 alone cannot separate correct
from faulty-from-3. For the unavailable case it confirms the connection is
refused. Every investigation launches its own Chromium process
and context. Failures are recorded, never retried.

Output goes to `runs/eval-<timestamp>/` (git-ignored):

- one directory per run, in the usual run format
- `results.jsonl`, written as each run finishes
- `summary.json` and `summary.md`: expected and actual verdict, end reason,
  clicks, quantities seen, any recorded wrong totals (Total ≠ Unit price ×
  Quantity), duration, tokens, model requests, whether the evidence checks
  passed, and the screenshot check. Each mismatch is classified as "bug not
  discovered" (the run stopped before the bug and every recorded total is
  correct) or "claim contradicts its own evidence".
- `contact-sheet.html` and `contact-sheet.png`: every cited observation's
  screenshot beside its recorded and cited values, for checking by eye

The screenshot check is automatic for existence, a valid PNG and a screenshot
for every cited observation. Whether an image shows the cited values is
checked by eye on the contact sheet.

`test/eval.test.ts` runs the same pipeline offline with the scripted test
double. That checks the harness, not the model.
