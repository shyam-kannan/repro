// One investigation's browser: a fresh Chromium process and context, limited
// to a single origin, exposing only "observe" and "click an observed element".
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  captureObservation,
  trackNetwork,
  waitForSettled,
  type ClickableElement,
  type LabeledField,
} from './observe.ts';

export type ObservedElement = ClickableElement & { elementId: string };

export type RecordedObservation = {
  id: string;
  seq: number;
  trigger: string;
  capturedAt: string;
  url: string;
  title: string;
  screenshot: string;
  ariaSnapshot: string;
  fields: LabeledField[];
  elements: ObservedElement[];
};

export type RecordedAction = {
  id: string;
  kind: 'open' | 'click';
  startedAt: string;
  durationMs: number;
  ok: boolean;
  target?: { elementId: string; role: string; name: string; nth: number; fromObservation: string };
  url?: string;
  beforeObservation?: string;
  afterObservation?: string;
  error?: string;
  settleWarning?: string;
};

export type BlockedRequest = { at: string; url: string; kind: 'request' | 'websocket' | 'popup' };

type SessionOptions = {
  storeUrl: string;
  runDir: string;
  actionTimeoutMs: number;
  launch?: () => Promise<Browser>;
};

// The model asked for something the current page cannot satisfy.
export class ToolInputError extends Error {}

const CONTEXT_OPTIONS = {
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'reduce',
  serviceWorkers: 'block',
} as const;

export class BrowserSession {
  readonly observations: RecordedObservation[] = [];
  readonly actions: RecordedAction[] = [];
  readonly blockedRequests: BlockedRequest[] = [];
  readonly cleanup = { contextClosed: false, browserClosed: false };

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private network?: { inFlight: () => number };
  private closing?: Promise<void>;
  private readonly origin: string;
  private readonly options: SessionOptions;

  constructor(options: SessionOptions) {
    this.options = options;
    this.origin = new URL(options.storeUrl).origin;
  }

  get latestObservation(): RecordedObservation | undefined {
    return this.observations.at(-1);
  }

  async start(): Promise<RecordedObservation> {
    this.browser = await (this.options.launch ?? (() => chromium.launch()))();
    this.context = await this.browser.newContext(CONTEXT_OPTIONS);
    this.context.setDefaultTimeout(this.options.actionTimeoutMs);

    await this.context.route('**/*', (route) => {
      const url = route.request().url();
      if (sameOrigin(url, this.origin)) return route.continue();
      this.blockedRequests.push({ at: new Date().toISOString(), url, kind: 'request' });
      return route.abort('blockedbyclient');
    });
    await this.context.routeWebSocket(/.*/, (ws) => {
      this.blockedRequests.push({ at: new Date().toISOString(), url: ws.url(), kind: 'websocket' });
      return ws.close();
    });

    const page = await this.context.newPage();
    this.page = page;
    this.context.on('page', (other) => {
      if (other === page) return;
      this.blockedRequests.push({ at: new Date().toISOString(), url: other.url(), kind: 'popup' });
      void other.close();
    });
    page.on('dialog', (dialog) => void dialog.dismiss());
    this.network = trackNetwork(page);

    const action = this.beginAction('open');
    action.url = this.options.storeUrl;
    try {
      await page.goto(this.options.storeUrl);
      await waitForSettled(page, this.network);
    } catch (error) {
      this.endAction(action, false, firstLine(error));
      throw error;
    }
    this.endAction(action, true);
    const observation = await this.observe(action.id);
    action.afterObservation = observation.id;
    return observation;
  }

  async observe(trigger: string): Promise<RecordedObservation> {
    const page = this.requirePage();
    const id = `obs-${this.observations.length + 1}`;
    const captured = await captureObservation(page, id, this.options.runDir);
    const observation: RecordedObservation = {
      id,
      seq: this.observations.length + 1,
      trigger,
      capturedAt: captured.capturedAt,
      url: captured.url,
      title: captured.title,
      screenshot: `${id}.png`,
      ariaSnapshot: captured.ariaSnapshot,
      fields: captured.fields,
      elements: captured.elements.map((element, index) => ({ ...element, elementId: `e${index + 1}` })),
    };
    this.observations.push(observation);
    return observation;
  }

  // Clicks an element from the latest observation, lets the page settle and
  // returns a fresh observation. The click target always comes from what the
  // page exposed, never from a selector the model wrote.
  async click(elementId: string): Promise<{ action: RecordedAction; observation: RecordedObservation }> {
    const page = this.requirePage();
    const latest = this.latestObservation;
    const element = latest?.elements.find((e) => e.elementId === elementId);
    if (!latest || !element) {
      throw new ToolInputError(
        `Unknown element_id "${elementId}". Use an element_id from the latest observation (${latest?.id ?? 'none'}).`,
      );
    }
    if (element.disabled) {
      throw new ToolInputError(`Element ${elementId} (${element.role} "${element.name}") is disabled in ${latest.id}.`);
    }

    const action = this.beginAction('click');
    action.target = { elementId, role: element.role, name: element.name, nth: element.nth, fromObservation: latest.id };
    action.beforeObservation = latest.id;
    try {
      await page
        .getByRole(element.role as Parameters<Page['getByRole']>[0], { name: element.name, exact: true })
        .nth(element.nth)
        .click();
    } catch (error) {
      this.endAction(action, false, firstLine(error));
      throw error;
    }
    try {
      await waitForSettled(page, this.network!);
    } catch (error) {
      action.settleWarning = firstLine(error);
    }
    this.endAction(action, true);
    const observation = await this.observe(action.id);
    action.afterObservation = observation.id;
    return { action, observation };
  }

  // Idempotent; safe to call from a deadline handler while other calls are pending.
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.context) {
        await this.context.close().catch(() => {});
        this.cleanup.contextClosed = true;
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.cleanup.browserClosed = !this.browser.isConnected();
      }
    })();
    return this.closing;
  }

  private beginAction(kind: RecordedAction['kind']): RecordedAction {
    const action: RecordedAction = {
      id: `act-${this.actions.length + 1}`,
      kind,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      ok: false,
    };
    this.actions.push(action);
    return action;
  }

  private endAction(action: RecordedAction, ok: boolean, error?: string) {
    action.ok = ok;
    action.durationMs = Date.now() - Date.parse(action.startedAt);
    if (error) action.error = error;
  }

  private requirePage(): Page {
    if (!this.page || this.closing) throw new Error('Browser session is not open');
    return this.page;
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}
