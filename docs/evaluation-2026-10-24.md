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

---

# Follow-up: a bug that starts at quantity 3

The question: what happens when the first click works and a later one
breaks? None of the three correct-store runs above went past one click.

## The `faulty-from-3` fixture

The server prices quantity 3 or more as if it were 2, so the total reads
$20 → $40 → $40 → $40. It uses the same page, JavaScript and controls as
the other fixtures. Its mode exists only in server-side pricing
(`demo-store/pricing.ts`), never in anything the browser receives.

`npm run smoke` now clicks three times per fixture and checks the total after
each click (69/69 checks). It confirms that all three fixtures serve
byte-identical HTML and JS and look identical before the first click. It
also confirms that **faulty-from-3 and correct are indistinguishable through
quantity 2**: same values, and identical screenshot bytes after the first
click. They differ only from quantity 3 ($40.00 vs $60.00).

The harness store check now prices 2 and then 3 mugs through the store API.
That separates all three fixtures: correct ($40, $60), faulty ($20, $20) and
faulty-from-3 ($40, $40). Checking quantity 2 alone could not tell correct
from faulty-from-3. The probe runs in the harness, outside the investigator's
fresh browser session. The store is stateless, so the probe cannot change
what the investigator sees.

## Live runs

`REPRO_MAX_OUTPUT_TOKENS=2048 npm run eval -- faulty-from-3`, once. Model,
prompts and limits were unchanged (no change under `src/`), with the original
cart complaint. The investigator was not told where the bug starts or how
many clicks to make. Artifacts are in
`runs/eval-faulty-from-3-2026-10-24T07-02-58-294Z/`, which Git ignores.

| Case | Store (confirmed) | Explored | Totals seen | Expected | Actual | Duration | Tokens in / out | Evidence checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| faulty-from-3-1 | faulty-from-3 | 2 clicks, qty 1→2→3 | $20 → $40 → **$40** | Reproduced | Reproduced | 7.3 s | 7,932 / 981 | passed, 6/6 |
| correct-control | correct | 2 clicks, qty 1→2→3 | $20 → $40 → $60 | Not reproduced in this run | Not reproduced in this run | 6.5 s | 7,994 / 796 | passed, 6/6 |
| faulty-from-3-2 | faulty-from-3 | 2 clicks, qty 1→2→3 | $20 → $40 → **$40** | Reproduced | Reproduced | 7.1 s | 7,985 / 1,006 | passed, 6/6 |
| faulty-from-3-3 | faulty-from-3 | 2 clicks, qty 1→2→3 | $20 → $40 → **$40** | Reproduced | Reproduced | 6.0 s | 7,984 / 829 | passed, 5/5 |

**4/4 matched.** Each faulty-from-3 report says the first increase worked and
the second left the total at $40.00 instead of $60.00. Each cites the qty-3
observation, and the `obs-3` screenshots show it. Run 1 also noted that "the
exact trigger ... is not established by two clicks". There were no retries,
tool errors or blocked requests.

No run stopped after one click, so none of these four shows the limitation
directly. That was partly luck, as the next section shows.

## How far the investigator explores

After its first click, every run wrote a short note such as "I'll click once
more to check that the behavior is consistent". It then stopped after the
second click, whatever it saw. Depth is a judgment call, not a search.

Every live cart-complaint run that saw "Quantity 2, Total $40.00" after its
first click shows how far the investigator chooses to go from that point.
Through quantity 2 the correct and faulty-from-3 stores look the same:

| Source | Runs | Stopped at qty 2 | Continued to qty 3 | Went past qty 3 |
| --- | --- | --- | --- | --- |
| `npm run trials` (correct) | 1 | 0 | 1 | 0 |
| UI live run (correct) | 1 | 1 | 0 | 0 |
| First evaluation (correct ×3) | 3 | 3 | 0 | 0 |
| This follow-up (faulty-from-3 ×3, correct ×1) | 4 | 0 | 4 | 0 |
| **Total** | **9** | **4** | **5** | **0** |

**This is evidence of limited exploration, not a measured miss rate.**

- **What actually happened on the buggy store:** none of the three
  faulty-from-3 runs missed the bug. All three reached quantity 3 and
  reported Reproduced.
- **The four early stops were all on the correct store**, where stopping at
  quantity 2 was harmless. They show that the investigator sometimes stops
  after one successful click. They do not show how often it would do so on
  the faulty-from-3 store, which was tested only three times.
- **No run went past quantity 3.** Nothing here shows whether the
  investigator would find a bug that starts later.

The sample is small and uneven over time: all three correct-store runs in one
batch stopped early, and none of the four runs in the next did. Exploration
depth should be measured directly on stores where it matters before any rate
is quoted.

## A missed bug versus a claim that contradicts its evidence

The harness now records how far each run went and which observations show
`Total ≠ Unit price × Quantity`. For a Not reproduced result on a buggy store,
it classifies the mismatch as one of two kinds:

- **Bug not discovered:** every recorded total is correct, and the run
  stopped before the bug. The claim "Not reproduced in this run" is literally
  true of what it saw. The failure is in exploration, and Repro's checks
  cannot catch it, because the evidence is real and consistent.
- **Claim contradicts its own evidence:** a recorded observation shows the
  wrong total, yet the run reported Not reproduced.

Neither happened in these four live runs. The offline test
(`test/eval.test.ts`, with labeled test doubles) produces both:

- The one-click double on faulty-from-3 is classified "Bug not discovered:
  the run stopped after 1 click(s) at quantity 2".
- A double that clicks twice, cites obs-3 (quantity 3, total $40.00) and
  still claims Not reproduced is flagged as a contradiction.

That test exposed an implementation gap: Repro's code kept the contradicting
verdict, because its evidence rules only confirmed that each citation matched
the page and that some value changed. **This has since been fixed** (see
"Reporting changes" below).

## Reporting changes after this evaluation

The model, prompts and exploration limits are unchanged. Only reporting
changed, and the four live runs above were not repeated.

**Coverage.** Every run now records what it actually covered, derived from
its recorded actions and observations, never from the model's description.
For example: "Tested quantities: 1, 2. Clicked button “Increase quantity”
once." Only values actually observed are listed; nothing in between is
implied. The UI shows this beside the verdict, and beside "Not reproduced in
this run" it adds that the verdict applies only to the states listed. The
server derives coverage when reading older records and never rewrites them.

**Demo cart pricing rule.** A "Not reproduced" verdict is downgraded to
Inconclusive when the run's own recorded observations contradict the demo's
pricing assumption: one line item, no discounts, tax, shipping or fees, so
Total = Unit price × Quantity. The reason names each contradicting
observation and its values, e.g. "obs-3 shows Quantity 3 and Unit price
$20.00, so Total should be $60.00, but it shows Total $40.00". The rule
checks every recorded observation, not only the cited ones. The record keeps
the model's proposed verdict (`proposedVerdict`) next to the final verdict,
along with the downgrade rule and reasons (`downgrade`).

The rule is deliberately narrow (`src/cart-pricing-rule.ts`). It applies only
when the complaint mentions both the total and the quantity, and every
observation shows exactly one readable Unit price, Quantity and Total. It
does not apply if any observation shows a discount, tax, shipping, fee,
subtotal or similar label. It reads browser observations only, never the
fixture name or the store's pricing code, and it is not a general rule for
real stores.

Limited coverage alone never triggers a downgrade. A run that observed only
quantities 1 and 2, with correct totals, keeps "Not reproduced in this run"
and states that coverage.

**Checked against the saved live records (read-only):** all 16 live run
records were re-evaluated in memory without modifying them, confirmed by
SHA-256 before and after. The rule applied to all six saved "Not reproduced"
runs (all on the correct store) and found no contradiction in any, so no
saved verdict would change. The coverage for the four early stops reads
"Tested quantities: 1, 2. Clicked button “Increase quantity” once."
Regression tests cover:

- the contradicted report, downgraded with obs-3 named
- a valid negative that observed only quantities 1 and 2, which is kept
- an unrelated complaint, where the rule does not apply
- pages with shipping, tax, discount, subtotal or coupon labels, or several
  line items, where the rule does not apply
- the UI display of all of the above, including an older record

## Harness error during this evaluation (fixed, no runs repeated)

The first summary of these runs reported "harness error: investigation
threw: Cannot access 'cents' before initialization" for all four. That was a
bug in `scripts/eval.ts`: the command-line block ran before a helper defined
further down the file was initialized. The offline test imported the module,
so it never hit that path. All four investigations had already finished and
saved their records. Only the harness's analysis afterwards failed.

The fix moves the entry point to the end of the module and narrows the error
handling, so an analysis failure can no longer be reported as a failed
investigation. A subprocess test now covers the command-line path. The
summary was rebuilt from the saved records with
`npm run eval -- --summarize <dir>`, which makes no model requests. The
`run.json` hashes were unchanged, and the broken summary is kept as
`harness-error-summary.*` in the same directory.
