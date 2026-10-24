# Evaluation, 2026-10-24

One run of `REPRO_MAX_OUTPUT_TOKENS=2048 npm run eval` with model
`claude-haiku-5-5`, the unchanged Spike B prompts, 15 browser tool calls and a
90 s deadline. Each case ran once and nothing was repeated or re-run. Generated
artifacts are in `runs/eval-2026-10-24T06-55-53-814Z/`, which Git ignores.

**Result: 8 of 8 verdicts matched the expected verdict.** This is a small
sample on one controlled store with one bug. It shows the investigator behaves
consistently on this case. It is not evidence of general reliability.

| Case | Store (confirmed before run) | Expected | Actual | Duration | Tokens in / out | Evidence checks |
| --- | --- | --- | --- | --- | --- | --- |
| correct-1 | correct | Not reproduced in this run | Not reproduced in this run | 4.7 s | 4,755 / 640 | passed, 4/4 |
| faulty-1 | faulty | Reproduced | Reproduced | 5.5 s | 7,932 / 769 | passed, 7/7 |
| correct-2 | correct | Not reproduced in this run | Not reproduced in this run | 4.3 s | 4,755 / 675 | passed, 4/4 |
| faulty-2 | faulty | Reproduced | Reproduced | 5.4 s | 7,935 / 790 | passed, 7/7 |
| correct-3 | correct | Not reproduced in this run | Not reproduced in this run | 5.6 s | 4,755 / 596 | passed, 4/4 |
| faulty-3 | faulty | Reproduced | Reproduced | 4.3 s | 4,755 / 691 | passed, 5/5 |
| store-unavailable | none (connection refused) | Inconclusive | Inconclusive | 0.2 s | 0 / 0 | n/a, no report |
| unrelated-complaint | correct | Inconclusive | Inconclusive | 5.1 s | 4,756 / 800 | passed, 3/3 |

Totals: 39,643 input and 4,961 output tokens, 35.2 s of investigation. There
were no model-request retries or failures, no tool errors, no blocked requests,
and every browser closed cleanly.

"Evidence checks passed" means every citation matched its recorded
observation and Repro kept the model's proposed verdict without downgrading
it.

## What each case showed

- **Correct store (3 runs):** each run opened the page, clicked "Increase
  quantity" once, and cited Quantity 1 / Total $20.00 → Quantity 2 /
  Total $40.00.
- **Faulty store (3 runs):** two runs clicked twice (Quantity 1 → 2 → 3) and
  one clicked once. The Total stayed at $20.00 throughout. The action
  sequence varied between runs, but the verdict did not.
- **Store unavailable:** the browser got `net::ERR_CONNECTION_REFUSED` on
  the first navigation and the run ended as `store_unreachable`. **No model
  request was made.** Code reached this verdict, so this case tests the
  failure path, not the model's judgment.
- **Unrelated complaint** ("Searching for headphones returns no results."):
  the model called `observe_page` once, found no search control (the only
  clickable element was "Increase quantity"), and reported Inconclusive
  because the scenario could not be exercised. It made no irrelevant clicks.
  Its citations (unit price and total) are valid but say nothing about
  search. Repro has no way to cite the *absence* of an element, so the
  "no search box" claim is supported by the accessibility outline and
  screenshots, not by a checked citation.

## Store and screenshot checks

- Before each investigation, the harness started a fresh store on an
  OS-assigned port and confirmed which fixture was answering by pricing two
  mugs through the store API ($40.00 = correct, $20.00 = faulty). The
  investigator never sees this probe. For the unavailable case it confirmed
  the connection was refused.
- Every investigation launched its own Chromium process and context.
- All 18 recorded observations have a valid 800×600 PNG, and every cited
  observation has its screenshot. On `contact-sheet.png` I checked by eye
  that each screenshot shows the cited Quantity and Total values. I also
  checked two at full size: faulty-2 `obs-3` (Quantity 3, Total $20.00) and
  correct-3 `obs-2` (Quantity 2, Total $40.00).

## Limitations

- Eight runs: six on one bug in one fixture pair, plus two failure cases. A
  run of 8/8 is compatible with a meaningful error rate. Three runs per
  fixture cannot rule one out.
- The bug is obvious: the total is wrong after the first click on the only
  button. Subtler or multi-step bugs are untested.
- One model, one prompt version and one complaint phrasing for the cart
  cases.
- The unavailable-store case never reaches the model.
