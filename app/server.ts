// The Repro web UI's backend: serves the static page, starts one investigation
// at a time, streams its recorded progress and serves saved reports. Model
// credentials stay in this process; the browser page only ever sees run data.
//
// Files per run, under <runsDir>/<run-id>/:
//   status.json   lifecycle state (running | finished | failed | interrupted)
//   events.jsonl  progress events, one JSON object per line, as recorded
//   run.json, transcript.json, obs-N.png  written by the investigator
import { randomBytes } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { InvestigatorSettings } from '../src/config.ts';
import { investigate, type InvestigationEvent, type RunRecord } from '../src/investigator.ts';
import type { ModelProvider } from '../src/provider.ts';
import { describeCoverage } from '../src/coverage.ts';
import type { Browser } from 'playwright';

export const EXAMPLE_COMPLAINTS = ['When I increase the quantity in my cart, the total stays the same.'];

const MAX_COMPLAINT_CHARS = 2_000;
const MAX_EXPECTED_CHARS = 1_000;
const MAX_BODY_BYTES = 16_000;
const RUN_ID = /^run-[0-9a-f]{8}$/;
const SCREENSHOT = /^obs-[1-9][0-9]{0,3}\.png$/;
// Margin past the investigator's own deadline before the server gives up on a run.
const WATCHDOG_GRACE_MS = 30_000;

const PUBLIC_DIR = new URL('./public/', import.meta.url);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

export type RunState = 'running' | 'finished' | 'failed' | 'interrupted';

export type RunStatus = {
  runId: string;
  state: RunState;
  complaint: string;
  startedAt: string;
  finishedAt?: string;
  verdict?: string;
  verdictCode?: string;
  endReason?: string;
  error?: string;
};

export type ReproServerOptions = {
  // null when REPRO_* configuration is missing; the UI still loads and explains.
  provider: ModelProvider | null;
  configProblems?: string[];
  settings: InvestigatorSettings | null;
  storeUrl: string;
  runsDir: string;
  launchBrowser?: () => Promise<Browser>;
  watchdogGraceMs?: number;
};

type ActiveRun = {
  runId: string;
  dir: string;
  status: RunStatus;
  events: InvestigationEvent[];
  listeners: Set<ServerResponse>;
  // Set once a final status is written. The lock is held until the
  // investigation itself settles, so a stuck browser never overlaps a new run.
  ended: boolean;
};

export type ReproServer = {
  server: Server;
  // Resolves when the active investigation (if any) has settled.
  idle: () => Promise<void>;
  // Marks the active run interrupted; used on shutdown.
  interruptActive: (reason: string) => void;
};

export async function createReproServer(options: ReproServerOptions): Promise<ReproServer> {
  const { runsDir } = options;
  await mkdir(runsDir, { recursive: true });
  await markAbandonedRuns(runsDir);

  const indexHtml = await readFile(new URL('index.html', PUBLIC_DIR));
  const assets = new Map(
    await Promise.all(
      Object.entries(STATIC_FILES).map(
        async ([route, { file, type }]) => [route, { body: await readFile(new URL(file, PUBLIC_DIR)), type }] as const,
      ),
    ),
  );

  let active: ActiveRun | null = null;
  let activePromise: Promise<void> = Promise.resolve();
  // Only requests addressed to this server's own loopback host are served.
  const allowedHosts = () => {
    const { port } = server.address() as AddressInfo;
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  };

  const writeStatus = (dir: string, status: RunStatus) =>
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2));

  const broadcast = (run: ActiveRun, event: object) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of run.listeners) res.write(line);
  };

  const endRun = (run: ActiveRun, status: RunStatus) => {
    if (run.ended) return;
    run.ended = true;
    run.status = status;
    writeStatus(run.dir, status);
    broadcast(run, { type: 'status', status });
    for (const res of run.listeners) res.end();
    run.listeners.clear();
  };

  const startRun = (complaint: string, expectedBehavior: string | undefined): RunStatus => {
    const runId = `run-${randomBytes(4).toString('hex')}`;
    const dir = join(runsDir, runId);
    const status: RunStatus = { runId, state: 'running', complaint, startedAt: new Date().toISOString() };
    const run: ActiveRun = { runId, dir, status, events: [], listeners: new Set(), ended: false };
    active = run;

    activePromise = (async () => {
      const watchdog = setTimeout(
        () =>
          endRun(run, {
            ...status,
            state: 'failed',
            finishedAt: new Date().toISOString(),
            error: 'The investigation did not finish within its deadline plus a grace period; the server stopped waiting.',
          }),
        options.settings!.deadlineMs + (options.watchdogGraceMs ?? WATCHDOG_GRACE_MS),
      );
      try {
        await mkdir(dir, { recursive: true });
        writeStatus(dir, status);
        const record = await investigate(
          { complaint, expectedBehavior, storeUrl: options.storeUrl },
          {
            provider: options.provider!,
            settings: options.settings!,
            runsDir,
            runId,
            launchBrowser: options.launchBrowser,
            onEvent: (event) => {
              if (run.ended) return;
              run.events.push(event);
              appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
              broadcast(run, event);
            },
          },
        );
        endRun(run, {
          ...status,
          state: 'finished',
          finishedAt: record.finishedAt,
          verdict: record.verdict,
          verdictCode: record.verdictCode,
          endReason: record.endReason,
        });
      } catch (error) {
        endRun(run, {
          ...status,
          state: 'failed',
          finishedAt: new Date().toISOString(),
          error: `The investigation could not complete: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        });
      } finally {
        clearTimeout(watchdog);
        if (active === run) active = null;
      }
    })();
    return status;
  };

  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    // Reject requests addressed to any other host name (DNS rebinding).
    if (!allowedHosts().has(req.headers.host ?? '')) return sendJson(res, 421, { error: 'Unexpected Host header.' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    try {
      if (req.method === 'GET' && (path === '/' || RUN_PAGE.test(path))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(indexHtml);
        return;
      }
      const asset = assets.get(path);
      if (req.method === 'GET' && asset) {
        res.writeHead(200, { 'Content-Type': asset.type }).end(asset.body);
        return;
      }

      if (req.method === 'GET' && path === '/api/status') {
        return sendJson(res, 200, {
          configured: options.provider !== null,
          configProblems: options.configProblems ?? [],
          model: options.settings?.model ?? null,
          provider: options.provider?.name ?? null,
          limits: options.settings
            ? { maxBrowserToolCalls: options.settings.maxBrowserToolCalls, deadlineMs: options.settings.deadlineMs }
            : null,
          storeUrl: options.storeUrl,
          activeRunId: active?.runId ?? null,
          examples: EXAMPLE_COMPLAINTS,
        });
      }

      if (path === '/api/runs' && req.method === 'GET') {
        return sendJson(res, 200, { runs: await listRuns(runsDir) });
      }

      if (path === '/api/runs' && req.method === 'POST') {
        if (!sameOriginPost(req, allowedHosts())) return sendJson(res, 403, { error: 'Cross-origin request refused.' });
        const body = await readJsonBody(req);
        if (!body.ok) return sendJson(res, 400, { error: body.error });
        const complaint = typeof body.value.complaint === 'string' ? body.value.complaint.trim() : '';
        const expectedRaw = body.value.expectedBehavior;
        const expected = typeof expectedRaw === 'string' && expectedRaw.trim() !== '' ? expectedRaw.trim() : undefined;
        if (!complaint) return sendJson(res, 400, { error: 'Enter a complaint to investigate.' });
        if (complaint.length > MAX_COMPLAINT_CHARS) {
          return sendJson(res, 400, { error: `The complaint is limited to ${MAX_COMPLAINT_CHARS} characters.` });
        }
        if (expectedRaw !== undefined && typeof expectedRaw !== 'string') {
          return sendJson(res, 400, { error: 'Expected behavior must be text.' });
        }
        if (expected && expected.length > MAX_EXPECTED_CHARS) {
          return sendJson(res, 400, { error: `Expected behavior is limited to ${MAX_EXPECTED_CHARS} characters.` });
        }
        if (!options.provider || !options.settings) {
          return sendJson(res, 503, {
            error: `Repro is not configured: ${(options.configProblems ?? []).join('; ')}. See README.md.`,
          });
        }
        if (active) {
          return sendJson(res, 409, {
            error: active.ended
              ? 'The previous investigation is still shutting down its browser. Try again in a moment.'
              : 'An investigation is already running. This local version runs one at a time; wait for it to finish.',
            activeRunId: active.runId,
          });
        }
        const status = startRun(complaint, expected);
        return sendJson(res, 202, status);
      }

      const runMatch = API_RUN.exec(path);
      if (runMatch && req.method === 'GET') {
        const [, runId, rest = ''] = runMatch;
        if (!RUN_ID.test(runId)) return sendJson(res, 404, { error: 'Run not found.' });
        const dir = join(runsDir, runId);
        if (rest === '') return sendRun(res, dir, runId);
        if (rest === '/events') return streamEvents(req, res, dir, runId);
        const file = rest.slice(1);
        if (SCREENSHOT.test(file)) return sendScreenshot(res, dir, file);
        return sendJson(res, 404, { error: 'Not found.' });
      }

      sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
      else res.end();
      console.error(error);
    }
  });

  const sendRun = async (res: ServerResponse, dir: string, runId: string) => {
    const status = active?.runId === runId ? active.status : await readStatus(dir);
    if (!status) return sendJson(res, 404, { error: 'Run not found.' });
    const events = active?.runId === runId ? active.events : await readEvents(dir);
    const record = await readJson<RunRecord>(join(dir, 'run.json'));
    sendJson(res, 200, { status, events, record: record ? publicRecord(record) : null });
  };

  // Server-sent events: replays what was already recorded, then streams live
  // events until the run ends. A finished run gets its replay and final status.
  const streamEvents = async (req: IncomingMessage, res: ServerResponse, dir: string, runId: string) => {
    const run = active?.runId === runId && !active.ended ? active : null;
    const status = run ? run.status : await readStatus(dir);
    if (!status) return sendJson(res, 404, { error: 'Run not found.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const events = run ? run.events : await readEvents(dir);
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (!run) {
      res.write(`data: ${JSON.stringify({ type: 'status', status })}\n\n`);
      return res.end();
    }
    run.listeners.add(res);
    req.on('close', () => run.listeners.delete(res));
  };

  return {
    server,
    idle: () => activePromise,
    interruptActive: (reason) => {
      if (active) endRun(active, { ...active.status, state: 'interrupted', finishedAt: new Date().toISOString(), error: reason });
    },
  };
}

const RUN_PAGE = /^\/runs\/run-[0-9a-f]{8}$/;
const API_RUN = /^\/api\/runs\/([^/]+)(\/[^/]*)?$/;

// A run left "running" by a server that stopped mid-investigation.
async function markAbandonedRuns(runsDir: string) {
  for (const entry of await readdir(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const dir = join(runsDir, entry.name);
    const status = await readStatus(dir);
    if (status?.state === 'running') {
      await writeFile(
        join(dir, 'status.json'),
        JSON.stringify(
          {
            ...status,
            state: 'interrupted',
            error: 'The Repro server stopped before this investigation finished.',
          } satisfies RunStatus,
          null,
          2,
        ),
      );
    }
  }
}

async function listRuns(runsDir: string): Promise<RunStatus[]> {
  const runs: RunStatus[] = [];
  for (const entry of await readdir(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const status = await readStatus(join(runsDir, entry.name));
    if (status) runs.push(status);
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
}

// The saved record minus the server's filesystem path.
// Records saved before coverage and proposedVerdict existed get them derived
// here from their own actions and observations; the file is never rewritten.
function publicRecord(record: RunRecord) {
  const { runDir: _runDir, ...rest } = record;
  return {
    ...rest,
    proposedVerdict: rest.proposedVerdict ?? rest.modelReport?.verdict ?? null,
    coverage: rest.coverage ?? describeCoverage(rest.observations, rest.actions),
  };
}

async function sendScreenshot(res: ServerResponse, dir: string, file: string) {
  try {
    const body = await readFile(join(dir, file));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' }).end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found.' });
  }
}

async function readStatus(dir: string): Promise<RunStatus | null> {
  return readJson<RunStatus>(join(dir, 'status.json'));
}

async function readEvents(dir: string): Promise<object[]> {
  try {
    const text = await readFile(join(dir, 'events.jsonl'), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ ok: false, error: 'Request body is too large.' });
      try {
        const value = JSON.parse(body);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
        resolve({ ok: true, value });
      } catch {
        resolve({ ok: false, error: 'Request body must be a JSON object.' });
      }
    });
  });
}

// Starting a run spends API credit, so only this page may start one.
function sameOriginPost(req: IncomingMessage, allowedHosts: Set<string>): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin';
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && allowedHosts.has(url.host);
  } catch {
    return false;
  }
}

function setSecurityHeaders(res: ServerResponse) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
      "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}
