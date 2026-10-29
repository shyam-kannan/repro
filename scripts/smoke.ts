// Browser smoke test. Runs the same cart flow (three increases, quantity 1 to
// 4) against every store fixture and checks the labeled observations after
// each click. Exits nonzero on any failure.
//
// The expected totals below belong to this harness. They never appear in the
// observations, which hold only what the browser showed.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createStoreServer } from '../demo-store/server.ts';
import type { Fixture } from '../demo-store/pricing.ts';
import {
  captureObservation,
  fieldValue,
  trackNetwork,
  waitForFieldChange,
  waitForSettled,
  type Observation,
} from '../src/observe.ts';

const ENTRY_PATH = '/';
const INCREASE_BUTTON = 'Increase quantity';
const ACTION_TIMEOUT_MS = 5_000;
const RUN_TIMEOUT_MS = 60_000;
const LEAK_PATTERN = /\b(correct|faulty|fixture|bug|expected|verdict)\b/i;

// Expected Total after each click (quantity 2, 3, 4).
const SCENARIOS: { fixture: Fixture; expectedTotals: string[] }[] = [
  { fixture: 'correct', expectedTotals: ['$40.00', '$60.00', '$80.00'] },
  { fixture: 'faulty', expectedTotals: ['$20.00', '$20.00', '$20.00'] },
  { fixture: 'faulty-from-3', expectedTotals: ['$40.00', '$40.00', '$40.00'] },
];

type Check = { name: string; pass: boolean; detail: string };

type ScenarioResult = {
  fixture: Fixture;
  checks: Check[];
  observations: Observation[];
  assetHashes: Record<string, string>;
};

const repoRoot = new URL('..', import.meta.url).pathname;
const rel = (path: string) => relative(repoRoot, path);

async function runScenario(
  fixture: Fixture,
  expectedTotals: string[],
  outDir: string,
): Promise<ScenarioResult> {
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    return pass;
  };
  const result: ScenarioResult = { fixture, checks, observations: [], assetHashes: {} };

  const server = createStoreServer(fixture);
  let browser: Browser | undefined;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const path of ['/', '/cart.js']) {
      const body = Buffer.from(await (await fetch(origin + path)).arrayBuffer());
      result.assetHashes[path] = createHash('sha256').update(body).digest('hex');
    }

    // A new browser process and context per run: no cookies, storage or cache carry over.
    browser = await chromium.launch().catch((error: Error) => {
      throw new Error(`${error.message}\nInstall the matching browser with: npm run browsers`);
    });
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    const page = await context.newPage();
    const network = trackNetwork(page);

    await page.goto(origin + ENTRY_PATH);
    await waitForSettled(page, network);
    const before = await captureObservation(page, 'before', outDir);
    result.observations.push(before);

    const unitBefore = fieldValue(before.fields, 'Unit price');
    const quantityBefore = fieldValue(before.fields, 'Quantity');
    const totalBefore = fieldValue(before.fields, 'Total');
    check('before: Unit price is $20.00', unitBefore.ok && unitBefore.value === '$20.00', describe(unitBefore));
    check('before: Quantity is 1', quantityBefore.ok && quantityBefore.value === '1', describe(quantityBefore));
    check('before: Total is $20.00', totalBefore.ok && totalBefore.value === '$20.00', describe(totalBefore));
    if (!quantityBefore.ok) return result;

    let previous = before;
    for (const [index, expectedTotal] of expectedTotals.entries()) {
      const click = index + 1;
      const expectedQuantity = String(click + 1);
      const quantityPrevious = fieldValue(previous.fields, 'Quantity');
      if (!quantityPrevious.ok) return result;
      try {
        await page.getByRole('button', { name: INCREASE_BUTTON, exact: true }).click();
        check(`click ${click} "${INCREASE_BUTTON}"`, true, 'click completed');
      } catch (error) {
        check(`click ${click} "${INCREASE_BUTTON}"`, false, (error as Error).message.split('\n')[0]);
        return result;
      }

      // Wait for the quantity, never the total: a total that stays wrong must be
      // observed as wrong, not turned into a timeout.
      const quantityChange = await waitForFieldChange(page, 'Quantity', quantityPrevious.value, {
        timeoutMs: ACTION_TIMEOUT_MS,
      });
      if (!check(`click ${click} changed Quantity`, quantityChange.ok, describe(quantityChange))) return result;
      await waitForSettled(page, network);

      const after = await captureObservation(page, `after-increase-${click}`, outDir);
      result.observations.push(after);
      previous = after;

      const unitAfter = fieldValue(after.fields, 'Unit price');
      const quantityAfter = fieldValue(after.fields, 'Quantity');
      const totalAfter = fieldValue(after.fields, 'Total');
      check(`after click ${click}: Unit price is $20.00`, unitAfter.ok && unitAfter.value === '$20.00', describe(unitAfter));
      if (
        !check(
          `after click ${click}: Quantity is ${expectedQuantity}`,
          quantityAfter.ok && quantityAfter.value === expectedQuantity,
          describe(quantityAfter),
        )
      ) {
        return result;
      }
      check(
        `after click ${click}: Total is ${expectedTotal}`,
        totalAfter.ok && totalAfter.value === expectedTotal,
        describe(totalAfter),
      );
    }

    for (const observation of result.observations) {
      const { size } = await stat(observation.screenshot);
      check(`screenshot ${observation.step} written`, size > 0, `${rel(observation.screenshot)} (${size} bytes)`);
    }
  } catch (error) {
    check('scenario completed', false, (error as Error).message);
  } finally {
    await browser?.close().catch(() => {});
    server.close();
    server.closeAllConnections();
  }
  return result;
}

function describe(result: { ok: true; value: string } | { ok: false; reason: string }): string {
  return result.ok ? `observed "${result.value}"` : result.reason;
}

// Every fixture is compared with the first one.
function crossScenarioChecks(results: ScenarioResult[]): Check[] {
  const checks: Check[] = [];
  const [a, ...others] = results;
  const sameAssets =
    Object.keys(a.assetHashes).length > 0 &&
    others.every((b) => Object.keys(a.assetHashes).every((path) => a.assetHashes[path] === b.assetHashes[path]));
  checks.push({ name: 'fixtures serve identical HTML and JS', pass: sameAssets, detail: JSON.stringify(a.assetHashes) });

  const beforeA = a.observations.find((o) => o.step === 'before');
  const sameBefore =
    !!beforeA &&
    others.every((b) => {
      const beforeB = b.observations.find((o) => o.step === 'before');
      return (
        !!beforeB &&
        beforeA.ariaSnapshot === beforeB.ariaSnapshot &&
        beforeA.title === beforeB.title &&
        new URL(beforeA.url).pathname === new URL(beforeB.url).pathname
      );
    });
  checks.push({
    name: 'fixtures look identical before the first click',
    pass: sameBefore,
    detail: 'same entry route, title and accessibility snapshot',
  });

  const leaks = results
    .flatMap((r) => r.observations)
    .flatMap((o) => [o.url, o.title, o.ariaSnapshot])
    .filter((text) => LEAK_PATTERN.test(text));
  checks.push({
    name: 'observations do not reveal fixture or expected result',
    pass: leaks.length === 0,
    detail: leaks.length === 0 ? `no match for ${LEAK_PATTERN}` : `matched in: ${leaks.join(' | ')}`,
  });
  return checks;
}

async function main(): Promise<boolean> {
  const runDir = join(repoRoot, 'runs', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(runDir, { recursive: true });
  console.log(`Playwright Chromium: ${chromium.executablePath()}`);
  console.log(`Run directory: ${rel(runDir)}\n`);

  const results: ScenarioResult[] = [];
  for (const { fixture, expectedTotals } of SCENARIOS) {
    results.push(await runScenario(fixture, expectedTotals, join(runDir, fixture)));
  }
  const shared = crossScenarioChecks(results);

  for (const result of results) {
    console.log(`== ${result.fixture} ==`);
    for (const observation of result.observations) {
      const fields = observation.fields.map((f) => `${f.label}: ${f.value}`).join(' | ');
      console.log(`  [${observation.step}] ${fields}`);
      console.log(`    screenshot: ${rel(observation.screenshot)}`);
    }
    printChecks(result.checks);
    await writeFile(
      join(runDir, result.fixture, 'observations.json'),
      JSON.stringify(result.observations.map((o) => ({ ...o, screenshot: rel(o.screenshot) })), null, 2),
    );
  }
  console.log('== all fixtures ==');
  printChecks(shared);

  const allChecks = [...results.flatMap((r) => r.checks), ...shared];
  const passed = allChecks.length > 0 && allChecks.every((c) => c.pass);
  await writeFile(
    join(runDir, 'summary.json'),
    JSON.stringify({ passed, scenarios: results.map(({ fixture, checks }) => ({ fixture, checks })), shared }, null, 2),
  );
  const failed = allChecks.filter((c) => !c.pass).length;
  console.log(`\n${passed ? 'PASS' : 'FAIL'}: ${allChecks.length - failed}/${allChecks.length} checks passed`);
  return passed;
}

function printChecks(checks: Check[]) {
  for (const c of checks) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name} — ${c.detail}`);
}

// Last-resort guard against a hang; Playwright kills its browsers on exit.
const watchdog = setTimeout(() => {
  console.error(`FAIL: smoke test exceeded ${RUN_TIMEOUT_MS}ms`);
  process.exit(1);
}, RUN_TIMEOUT_MS);
watchdog.unref();

main()
  .then((passed) => {
    process.exitCode = passed ? 0 : 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
