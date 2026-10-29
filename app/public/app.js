// Repro UI. Plain DOM code; every piece of complaint text, page content and
// model output is inserted with textContent, never parsed as HTML.

const app = document.getElementById('app');
const serverState = document.getElementById('server-state');

const VERDICT_TEXT = {
  reproduced: 'The investigator saw the behavior the bug report describes.',
  not_reproduced: 'The investigator performed the scenario and saw the expected behavior. This is one run, not proof the bug cannot happen.',
  inconclusive: 'This run does not support either conclusion.',
};

// Where a run's end came from, so failures are not mistaken for each other.
const END_REASON_TEXT = {
  report_submitted: null,
  provider_error: 'Model API failure: a model request failed (network, credentials, rate limit or server error).',
  store_unreachable: 'Browser failure: the store page could not be opened.',
  execution_error: 'Unexpected Repro error.',
  deadline: 'Time limit: the run reached its deadline before a report was submitted.',
  browser_tool_limit: 'Tool-call limit: the model used all browser tool calls without submitting a report.',
  model_refusal: 'Model mistake: the model declined to continue.',
  output_token_limit: 'Model mistake: a model response hit the output-token limit.',
  no_report: 'Model mistake: the model stopped without submitting a report.',
  malformed_report: 'Model mistake: the report was malformed twice.',
};

const VERDICT_LABEL = { reproduced: 'Reproduced', not_reproduced: 'Not reproduced in this run', inconclusive: 'Inconclusive' };
// Each status has an icon and a word, so colour is never the only signal.
const BADGE_ICON = { reproduced: '!', not_reproduced: '✓', inconclusive: '?', failed: '✕', interrupted: '■', running: '…' };

const DOWNGRADE_TEXT = {
  citation_mismatch: 'Evidence validation failure: a cited value did not match the recorded page.',
  scenario_not_exercised: 'Evidence rule: the report did not show the scenario was exercised.',
  demo_cart_total_equals_unit_price_times_quantity:
    'Contradicted by its own evidence (demo cart pricing rule: Total = Unit price × Quantity, one item, no discounts, tax or shipping).',
};

let status = null;
let teardown = () => {};

// ---------- DOM helpers ----------

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function setView(...children) {
  teardown();
  teardown = () => {};
  app.replaceChildren(...children.flat().filter(Boolean));
}

const fmtSeconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const fmtShortTime = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const clock = (startIso, atIso) => {
  const s = Math.max(0, (Date.parse(atIso) - Date.parse(startIso)) / 1000);
  return `+${s.toFixed(1)}s`;
};
const shotUrl = (runId, file) => `/api/runs/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`;
const fieldsText = (fields) => fields.map((f) => `${f.label} ${f.value}`).join(' · ');

function badge(code, label) {
  return h('span', { class: `badge ${code}` }, h('span', { class: 'icon', 'aria-hidden': 'true' }, BADGE_ICON[code] ?? '•'), label);
}

async function api(path, init) {
  const response = await fetch(path, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // non-JSON error bodies are reported by status code below
  }
  if (!response.ok) {
    const error = new Error(body?.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

// ---------- routing ----------

function route() {
  const match = /^\/runs\/(run-[0-9a-f]{8})$/.exec(location.pathname);
  if (match) return showRun(match[1]);
  return showHome();
}

function navigate(path) {
  history.pushState(null, '', path);
  route();
}

window.addEventListener('popstate', route);
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-nav]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});

async function refreshStatus() {
  status = await api('/api/status');
  serverState.hidden = false;
  if (!status.configured) {
    serverState.className = 'pill failed';
    serverState.textContent = 'Not configured';
  } else if (status.activeRunId) {
    serverState.className = 'pill running';
    serverState.textContent = 'Investigation running';
  } else {
    serverState.className = 'pill';
    serverState.textContent = 'Ready';
  }
  return status;
}

// ---------- home ----------

async function showHome() {
  document.title = 'Repro';
  let runs = [];
  try {
    await refreshStatus();
    runs = (await api('/api/runs')).runs;
  } catch (error) {
    setView(h('div', { class: 'notice' }, `Could not reach the Repro server: ${error.message}`));
    return;
  }

  const complaint = h('textarea', { id: 'complaint', name: 'complaint', maxlength: 2000, placeholder: 'Describe what went wrong, as a user would.', required: true });
  const expected = h('textarea', { id: 'expected', name: 'expected', class: 'short', maxlength: 1000, placeholder: 'For example: the total should equal unit price × quantity.' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Investigate');
  const formError = h('span', { class: 'error-text', role: 'alert' });

  const blocked = !status.configured || status.activeRunId;
  submit.disabled = Boolean(blocked);

  // The selected scenario is remembered in this browser only, as a convenience.
  const remembered = (() => {
    try {
      return localStorage.getItem('repro.scenario');
    } catch {
      return null;
    }
  })();
  const selected = status.scenarios.some((s) => s.id === remembered) ? remembered : status.defaultScenario;
  const scenarioChoices = h(
    'fieldset',
    { class: 'scenarios' },
    h('legend', {}, h('span', { class: 'step-head' }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, '1'), h('h2', {}, 'Choose how the demo store behaves'))),
    h('p', { class: 'step-hint' }, 'The investigator is not told which one you pick. It has to find out in the browser.'),
    h(
      'div',
      { class: 'scenario-grid' },
      status.scenarios.map((scenario) =>
        h(
          'label',
          { class: 'scenario' },
          h('input', {
            type: 'radio',
            name: 'scenario',
            value: scenario.id,
            checked: scenario.id === selected,
            onchange: () => {
              try {
                localStorage.setItem('repro.scenario', scenario.id);
              } catch {
                // storage unavailable: the choice still applies to this form
              }
            },
          }),
          h('span', { class: 'scenario-label' }, scenario.label),
          h('span', { class: 'scenario-description' }, scenario.description),
          // Shown on the selected card; text, not only colour.
          h('span', { class: 'scenario-state', 'aria-hidden': 'true' }, 'Selected'),
        ),
      ),
    ),
    // Links sit outside the radio cards so keyboard order stays: choice, then links.
    h(
      'p',
      { class: 'store-links small muted' },
      'Try a store yourself: ',
      status.scenarios.map((scenario, i) => [
        i ? ' · ' : '',
        h('a', { href: scenario.storeUrl, target: '_blank', rel: 'noopener' }, `${scenario.label} ↗`),
      ]),
    ),
  );
  // Keep the "Selected" label on the checked card only.
  const syncSelected = () => {
    for (const card of scenarioChoices.querySelectorAll('label.scenario')) {
      card.querySelector('.scenario-state').hidden = !card.querySelector('input').checked;
    }
  };
  scenarioChoices.addEventListener('change', syncSelected);
  syncSelected();
  const selectedScenario = () => scenarioChoices.querySelector('input[name="scenario"]:checked')?.value;

  const form = h(
    'form',
    {
      class: 'panel compose',
      onsubmit: async (event) => {
        event.preventDefault();
        formError.textContent = '';
        submit.disabled = true;
        submit.textContent = 'Starting…';
        try {
          const run = await api('/api/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ complaint: complaint.value, expectedBehavior: expected.value, scenario: selectedScenario() }),
          });
          navigate(`/runs/${run.runId}`);
        } catch (error) {
          formError.textContent = error.message;
          if (error.body?.activeRunId) {
            append(formError, ' ', h('a', { href: `/runs/${error.body.activeRunId}`, 'data-nav': true }, 'View the running investigation'));
          }
          submit.disabled = false;
          submit.textContent = 'Investigate';
        }
      },
    },
    h('div', { class: 'compose-step' }, scenarioChoices),
    h(
      'div',
      { class: 'compose-step' },
      h('div', { class: 'step-head' }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, '2'), h('label', { for: 'complaint', class: 'field-label' }, 'Bug report')),
      h('p', { class: 'step-hint' }, 'Write it the way a customer would. Repro decides which steps to try.'),
      complaint,
      h(
        'div',
        { class: 'compose-extras' },
        h(
          'div',
          { class: 'examples' },
          h('span', { class: 'muted small' }, 'Example:'),
          status.examples.map((text) =>
            h('button', { type: 'button', class: 'chip', onclick: () => { complaint.value = text; complaint.focus(); } }, text),
          ),
        ),
        h(
          'details',
          { class: 'optional' },
          h('summary', {}, 'Add an expected behavior (optional)'),
          h('label', { for: 'expected', class: 'small muted' }, 'If you leave this empty, the investigator infers the expectation and lists its assumptions.'),
          expected,
        ),
      ),
      h(
        'div',
        { class: 'compose-actions' },
        submit,
        status.limits
          ? h('span', { class: 'compose-meta' }, `Fresh Chromium browser · up to ${status.limits.maxBrowserToolCalls} browser actions · ${status.limits.deadlineMs / 1000} s limit`)
          : null,
      ),
      h('p', {}, formError),
    ),
  );

  const notices = [];
  if (!status.configured) {
    notices.push(
      h('div', { class: 'notice' }, 'Repro cannot investigate yet: ', status.configProblems.join('; '), '. Set these in .env and restart (see README.md).'),
    );
  }
  if (status.activeRunId) {
    notices.push(
      h(
        'div',
        { class: 'notice info' },
        'An investigation is running. This local version runs one at a time. ',
        h('a', { href: `/runs/${status.activeRunId}`, 'data-nav': true }, 'Follow its progress'),
      ),
    );
  }

  const recent = h(
    'section',
    { class: 'panel recent', 'aria-labelledby': 'recent-title' },
    h('div', { class: 'section-head' }, h('h2', { id: 'recent-title' }, 'Recent investigations'), runs.length ? h('span', { class: 'muted small' }, `${runs.length} shown`) : null),
    runs.length
      ? [
          h('div', { class: 'run-cols eyebrow', 'aria-hidden': 'true' }, h('span', {}, 'Verdict'), h('span', {}, 'Bug report'), h('span', {}, 'Scenario'), h('span', { class: 'run-when' }, 'Started')),
          h(
            'ul',
            { class: 'run-list' },
            runs.map((run) =>
              h(
                'li',
                {},
                h(
                  'a',
                  { href: `/runs/${run.runId}`, 'data-nav': true },
                  statePill(run),
                  h('span', { class: 'run-complaint' }, run.complaint),
                  h('span', { class: 'run-scenario' }, run.scenario ? run.scenario.label : 'Scenario not recorded'),
                  h('span', { class: 'run-when' }, h('time', { datetime: run.startedAt, title: fmtTime(run.startedAt) }, fmtShortTime(run.startedAt))),
                ),
              ),
            ),
          ),
        ]
      : h('p', { class: 'empty' }, 'No investigations yet. Your first one will appear here.'),
  );

  const hero = h(
    'section',
    { class: 'hero intro' },
    h('h1', {}, 'Reproduce a bug report in a real browser'),
    h(
      'p',
      { class: 'lede' },
      'Repro takes a plain-English bug report, tries it in a demo store with a real browser, and returns a verdict backed by screenshots and the values it read from the page.',
    ),
  );
  setView(hero, notices, form, recent);
}

function statePill(run) {
  if (run.state === 'finished') return badge(run.verdictCode, run.verdict);
  const label = { running: 'Running', failed: 'Failed', interrupted: 'Interrupted' }[run.state] ?? run.state;
  return badge(run.state, label);
}

// ---------- run page ----------

async function showRun(runId) {
  document.title = `Repro · ${runId}`;
  refreshStatus().catch(() => {});
  let data;
  try {
    data = await api(`/api/runs/${runId}`);
  } catch (error) {
    setView(backLink(), h('div', { class: 'notice' }, error.status === 404 ? `Run ${runId} was not found.` : `Could not load ${runId}: ${error.message}`));
    return;
  }
  if (data.status.state === 'running') return showLiveRun(runId, data.status);
  renderFinished(runId, data);
}

function backLink() {
  return h('p', { class: 'back' }, h('a', { href: '/', 'data-nav': true }, '← New investigation'));
}

function runHeader(runId, runStatus, setup) {
  const scenario = setup?.scenario ?? runStatus.scenario;
  return h(
    'section',
    { class: 'panel report-meta', 'data-section': 'report' },
    h(
      'div',
      {},
      h('h2', { class: 'eyebrow' }, 'Bug report'),
      h('blockquote', { class: 'complaint' }, runStatus.complaint),
      h('p', { class: 'run-id mono' }, `${runId} · started ${fmtTime(runStatus.startedAt)}`),
    ),
    h(
      'div',
      { class: 'demo-setup', 'data-scenario': scenario?.id ?? '' },
      h('h2', { class: 'eyebrow' }, 'Demo scenario'),
      scenario
        ? [
            h('p', { class: 'scenario-name' }, scenario.label),
            scenario.description ? h('p', { class: 'muted small' }, scenario.description) : null,
            h('p', { class: 'muted small' }, 'Chosen by the person running the demo when the run started. The investigator was not told.'),
          ]
        : h('p', { class: 'muted small scenario-name' }, 'Not recorded (this run was made before scenario selection existed).'),
    ),
  );
}

// ---------- timeline: recorded events as readable steps ----------

// One row per recorded event. Pending rows (a model request or browser action
// that has started) resolve in place when their result event arrives; only
// the latest pending row is marked as current.
function createTimeline(runId, startIso, { live }) {
  const list = h('ol', { class: 'timeline activity' });
  const pending = [];
  const ICON = { done: '✓', current: '•', failed: '✕', incomplete: '!' };
  const STATE_TEXT = { current: 'Now', failed: 'Failed', incomplete: 'Did not finish' };

  const setState = (li, state) => {
    li.dataset.state = state;
    li.querySelector('.step-icon').textContent = ICON[state];
    const label = li.querySelector('.step-state');
    label.textContent = STATE_TEXT[state] ?? '';
    label.hidden = !STATE_TEXT[state];
  };
  const row = (at, title, detail, { state = 'done', minor = false, key } = {}) => {
    const li = h(
      'li',
      { class: minor ? 'minor' : null, 'data-key': key },
      h('span', { class: 'step-icon', 'aria-hidden': 'true' }),
      h('div', { class: 'step-body' }, h('div', {}, h('span', { class: 'step-title' }, title), h('span', { class: 'step-state' })), detail ? h('div', { class: 'step-detail' }, detail) : null),
      h('span', { class: 'step-time' }, clock(startIso, at)),
    );
    setState(li, state);
    if (state === 'current') pending.push(li);
    list.append(li);
    return li;
  };
  const resolve = (key, title, detail, state = 'done') => {
    const li = key ? list.querySelector(`li[data-key="${key}"]`) : null;
    if (!li) return false;
    li.querySelector('.step-title').textContent = title;
    const body = li.querySelector('.step-body');
    body.querySelector('.step-detail')?.remove();
    if (detail) body.append(h('div', { class: 'step-detail' }, detail));
    pending.splice(pending.indexOf(li), 1);
    setState(li, state);
    return true;
  };

  let toolKey = null;
  const add = (event) => {
    switch (event.type) {
      case 'run_started':
        row(event.at, 'Started a fresh browser', `Limits: ${event.limits.maxBrowserToolCalls} browser actions, ${event.limits.deadlineMs / 1000} s`);
        break;
      case 'action': {
        const a = event.action;
        const title = a.kind === 'open' ? 'Opened the store page' : `Clicked ${a.target?.role ?? ''} “${a.target?.name ?? ''}”`;
        const detail = a.ok ? (a.settleWarning ? `Page did not fully settle: ${a.settleWarning}` : a.kind === 'open' ? h('span', { class: 'mono' }, a.url ?? '') : null) : `Failed: ${a.error}`;
        if (!(a.kind === 'click' && toolKey && resolve(toolKey, title, detail, a.ok ? 'done' : 'failed'))) {
          row(event.at, title, detail, { state: a.ok ? 'done' : 'failed' });
        }
        if (a.kind === 'click') toolKey = null;
        break;
      }
      case 'observation': {
        const o = event.observation;
        const detail = [
          h('span', { class: 'values' }, fieldsText(o.fields) || 'no labeled values'),
          ' · ',
          h('a', { href: shotUrl(runId, o.screenshot), target: '_blank', rel: 'noopener' }, 'screenshot'),
        ];
        const title = `Recorded the page (${o.id})`;
        if (!(o.trigger === 'observe_page' && toolKey && resolve(toolKey, title, detail))) row(event.at, title, detail);
        if (o.trigger === 'observe_page') toolKey = null;
        break;
      }
      case 'model_request_started':
        row(event.at, `Waiting for the model to choose the next step${event.attempt > 1 ? ` (attempt ${event.attempt})` : ''}`, null, {
          state: 'current',
          minor: true,
          key: `${event.id}-${event.attempt}`,
        });
        break;
      case 'model_request_finished': {
        const c = event.call;
        const key = `${c.id}-${c.attempt}`;
        const ok = c.ok;
        const title = ok ? `Model answered in ${fmtSeconds(c.durationMs)}` : 'Model request failed';
        const detail = ok ? null : `${c.error?.kind ?? ''}${c.error?.status ? ` ${c.error.status}` : ''} ${c.error?.message ?? ''}`.trim();
        if (!resolve(key, title, detail, ok ? 'done' : 'failed')) row(event.at, title, detail, { state: ok ? 'done' : 'failed', minor: true });
        break;
      }
      case 'browser_tool_requested': {
        toolKey = `tool-${event.callNumber}`;
        const title = event.target
          ? `Clicking ${event.target.role} “${event.target.name}”`
          : event.tool === 'observe_page'
            ? 'Reading the page again'
            : `Running ${event.tool}`;
        row(event.at, title, `Browser action ${event.callNumber}${status?.limits ? ` of ${status.limits.maxBrowserToolCalls}` : ''}`, { state: 'current', key: toolKey });
        break;
      }
      case 'tool_error':
        if (toolKey && resolve(toolKey, `Browser action failed (${event.error.tool})`, event.error.message, 'failed')) toolKey = null;
        else row(event.at, `Browser action failed (${event.error.tool})`, event.error.message, { state: 'failed' });
        break;
      case 'report_submitted':
        row(event.at, 'Model submitted its report', `Proposed: ${VERDICT_LABEL[event.proposedVerdict] ?? event.proposedVerdict} · ${event.citations} citations. Repro checks them against the recorded page.`, {
          state: live ? 'current' : 'done',
          key: 'report',
        });
        break;
      case 'run_finished':
        resolve('report', 'Model submitted its report; evidence checked', null);
        row(event.at, `Final verdict: ${event.verdict}`, null);
        break;
      default:
        return;
    }
    markCurrent();
  };
  // Only the newest pending row is "Now"; in a saved log, any row still
  // pending never finished.
  const markCurrent = () => {
    const open = pending.filter((li) => li.isConnected);
    open.forEach((li, i) => setState(li, live && i === open.length - 1 ? 'current' : live ? 'done' : 'incomplete'));
  };
  return { list, add, finish: () => { live = false; markCurrent(); } };
}

// Live progress: replays recorded events, then follows new ones over SSE.
function showLiveRun(runId, runStatus) {
  let timeline = createTimeline(runId, runStatus.startedAt, { live: true });
  const holder = h('div', {}, timeline.list);
  const elapsed = h('span', {});
  const toolCalls = h('span', {});
  const modelCalls = h('span', {});
  const panel = h(
    'section',
    { class: 'verdict running' },
    h('div', { class: 'live-head' }, badge('running', 'In progress'), h('span', { class: 'muted small' }, 'Showing only what Repro has recorded so far.')),
    h('div', { class: 'verdict-label' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Investigating'),
    h('div', { class: 'counters' }, elapsed, toolCalls, modelCalls),
  );
  const connection = h('p', { class: 'small muted' }, 'Steps appear as the browser performs them.');
  setView(
    backLink(),
    panel,
    runHeader(runId, runStatus),
    h('section', { class: 'panel', 'data-section': 'live' }, h('div', { class: 'section-head' }, h('h2', {}, 'What the browser has done'), connection), holder),
  );

  const state = { limits: null, tools: 0, models: 0 };
  const tick = () => {
    elapsed.replaceChildren('Elapsed ', h('strong', {}, `${((Date.now() - Date.parse(runStatus.startedAt)) / 1000).toFixed(0)} s`));
  };
  tick();
  const timer = setInterval(tick, 1000);

  let source = null;
  let reconnects = 0;
  let done = false;

  const finish = async () => {
    done = true;
    source?.close();
    clearInterval(timer);
    try {
      renderFinished(runId, await api(`/api/runs/${runId}`));
      refreshStatus().catch(() => {});
    } catch (error) {
      connectionLost(error.message);
    }
  };

  const connectionLost = (detail) => {
    done = true;
    source?.close();
    clearInterval(timer);
    timeline.finish();
    panel.className = 'verdict interrupted';
    panel.replaceChildren(
      h('div', { class: 'verdict-top' }, badge('interrupted', 'Connection lost')),
      h('div', { class: 'verdict-label' }, 'Lost contact with the Repro server'),
      h('p', { class: 'verdict-note' }, 'The run may have been interrupted. Restart Repro if it stopped, then reload this page to see the saved result.'),
      detail ? h('p', { class: 'small muted' }, detail) : null,
    );
  };

  const connect = () => {
    timeline = createTimeline(runId, runStatus.startedAt, { live: true });
    holder.replaceChildren(timeline.list);
    Object.assign(state, { tools: 0, models: 0 });
    source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (message) => {
      reconnects = 0;
      const event = JSON.parse(message.data);
      if (event.type === 'status') {
        if (event.status.state !== 'running') void finish();
        return;
      }
      if (event.type === 'run_started') state.limits = event.limits;
      if (event.type === 'browser_tool_requested') state.tools = event.callNumber;
      if (event.type === 'model_request_started') state.models += 1;
      timeline.add(event);
      if (state.limits) toolCalls.replaceChildren('Browser actions ', h('strong', {}, `${state.tools} of ${state.limits.maxBrowserToolCalls}`));
      modelCalls.replaceChildren('Model requests ', h('strong', {}, String(state.models)));
    };
    source.onerror = async () => {
      if (done) return;
      source.close();
      // Ask the server directly: the run may have ended, or the server may be gone.
      try {
        const data = await api(`/api/runs/${runId}`);
        if (data.status.state !== 'running') return void finish();
        if (reconnects++ < 5) {
          connection.textContent = 'Reconnecting to the event stream…';
          setTimeout(() => !done && connect(), 1000);
        } else {
          connectionLost('The event stream kept closing.');
        }
      } catch (error) {
        connectionLost(error.message);
      }
    };
  };
  connect();
  teardown = () => {
    done = true;
    source?.close();
    clearInterval(timer);
  };
}

// ---------- finished report ----------

function renderFinished(runId, data) {
  const { status: runStatus, record, events, setup, finding, pricingCheck } = data;
  const timeline = createTimeline(runId, runStatus.startedAt, { live: false });
  for (const event of events) timeline.add(event);
  timeline.finish();
  const log = h(
    'details',
    { class: 'card log', 'data-section': 'activity' },
    h('summary', {}, 'Activity log', h('span', { class: 'summary-meta' }, `${events.length} recorded events`)),
    h('div', { class: 'details-body' }, events.length ? timeline.list : h('p', { class: 'muted' }, 'No activity log was saved for this run.')),
  );

  if (!record) {
    const label = runStatus.state === 'interrupted' ? 'Interrupted' : 'Failed';
    setView(
      backLink(),
      h(
        'section',
        { class: `verdict ${runStatus.state}` },
        h('div', { class: 'verdict-top' }, badge(runStatus.state, label), h('span', { class: 'muted small' }, 'No report was saved')),
        h('div', { class: 'verdict-label' }, label),
        h('p', { class: 'verdict-note' }, runStatus.error ?? 'The investigation ended without saving a report.'),
        h('p', { class: 'small muted' }, 'Whatever was recorded before it stopped is in the activity log below.'),
      ),
      runHeader(runId, runStatus, setup),
      log,
    );
    return;
  }

  const labels = stepLabels(record);
  setView(
    backLink(),
    record.provider.startsWith('TEST DOUBLE')
      ? h('div', { class: 'banner-double' }, `This run used a scripted test double, not a real model (${record.provider}). It verifies the UI and pipeline only.`)
      : null,
    summaryPanel(record, runStatus, finding),
    runHeader(runId, runStatus, setup),
    comparisonCard(runId, record, finding, pricingCheck, labels),
    actionsCard(record, labels),
    modelCard(record),
    citationsCard(record, labels),
    detailsCard(record),
    log,
  );
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = (n) => ORDINALS[n - 1] ?? `${n}th`;

// Readable names for each observation, from the action that produced it:
// "Page opened", "After the first increase", "After the second increase", ...
function stepLabels(record) {
  const labels = new Map();
  const clicksByTarget = new Map();
  for (const o of record.observations) {
    const action = record.actions.find((a) => a.id === o.trigger);
    if (!action) {
      labels.set(o.id, o.trigger === 'observe_page' ? 'Page checked again' : `After ${o.trigger}`);
    } else if (action.kind === 'open') {
      labels.set(o.id, 'Page opened');
    } else {
      const name = action.target?.name ?? '';
      const n = (clicksByTarget.get(name) ?? 0) + 1;
      clicksByTarget.set(name, n);
      const increase = /^Increase\b/i.test(name);
      labels.set(o.id, increase ? `After the ${ordinal(n)} increase` : `After clicking “${name}” (${ordinal(n)} time)`);
    }
  }
  return { of: (id) => labels.get(id) ?? id };
}

// The top of the report: verdict, what the evidence shows, and what was covered.
function summaryPanel(record, runStatus, finding) {
  const reasons = [];
  const endText = END_REASON_TEXT[record.endReason];
  if (endText) reasons.push(endText);
  const downgrade = record.downgrade;
  // Older records have no downgrade field; fall back to comparing verdicts.
  const legacyDowngrade = !downgrade && record.proposedVerdict && record.proposedVerdict !== record.verdictCode;
  if (downgrade) reasons.push(DOWNGRADE_TEXT[downgrade.rule] ?? `Downgraded by rule ${downgrade.rule}.`);
  else if (legacyDowngrade) reasons.push('Repro downgraded the model’s proposed verdict.');
  const proposed = downgrade?.from ?? (legacyDowngrade ? record.proposedVerdict : null);
  const allReasons = [...reasons, ...record.verdictReasons];
  return h(
    'section',
    { class: `verdict ${record.verdictCode}`, 'data-verdict': record.verdictCode },
    h('div', { class: 'verdict-top' }, badge(record.verdictCode, record.verdict), h('span', { class: 'muted small' }, `Finished in ${fmtSeconds(record.durationMs)}`)),
    proposed
      ? h('div', { class: 'proposed', 'data-proposed': proposed }, 'Model proposed: ', h('strong', {}, VERDICT_LABEL[proposed] ?? proposed), ' → final verdict: ', h('strong', {}, record.verdict))
      : null,
    finding
      ? h(
          'div',
          { class: `finding${finding.kind === 'none' ? ' none' : ''}`, 'data-finding': finding.kind },
          h('span', { class: 'eyebrow' }, 'What the browser showed'),
          h('span', { class: 'finding-text' }, finding.text),
          finding.inferredExpectation ? h('span', { class: 'inferred-note' }, finding.inferredExpectation) : null,
        )
      : null,
    allReasons.length ? h('ul', { class: 'reasons' }, allReasons.map((r) => h('li', {}, r))) : null,
    record.coverage
      ? h(
          'div',
          { class: 'coverage', 'data-coverage': true },
          h('span', { class: 'eyebrow' }, 'Coverage'),
          h('span', { class: 'coverage-text' }, record.coverage.summary),
          record.verdictCode === 'not_reproduced'
            ? h('span', { class: 'coverage-note' }, 'This verdict applies only to the states listed. Values that were never observed were not tested.')
            : null,
        )
      : null,
    h('p', { class: 'verdict-note' }, VERDICT_TEXT[record.verdictCode]),
    runStatus.state === 'interrupted' ? h('p', {}, runStatus.error) : null,
  );
}

function comparisonCard(runId, record, finding, pricing, labels) {
  const observations = record.observations;
  if (!observations.length) {
    return h(
      'section',
      { class: 'panel evidence', 'data-section': 'evidence' },
      h('h2', {}, 'Before and after'),
      h('p', { class: 'muted' }, 'No observations were recorded, so there is nothing to compare.'),
    );
  }
  const fieldLabels = [...new Set(observations.flatMap((o) => o.fields.map((f) => f.label)))];
  const valueOf = (o, label) => o.fields.find((f) => f.label === label)?.value;
  const citation = (o, label) => record.evidence.find((c) => c.observation_id === o.id && c.label === label);
  const position = (o) => observations.indexOf(o);
  // A Total that the scoped pricing check found inconsistent with Unit price ×
  // Quantity. Nothing is marked when the check does not apply.
  const contradiction = (o, label) =>
    label === 'Total' && pricing?.applies ? pricing.contradictions.find((c) => c.observation === o.id) : undefined;
  const flag = (wrong) => h('span', { class: 'flag' }, `✕ Expected ${wrong.expectedTotal} (inferred)`);
  // How a value is shown: contradicting the inferred expectation, a change
  // (with the wording given by the caller), or plain. Markings carry text.
  const marked = (o, label, value, compared, changeText) => {
    const wrong = contradiction(o, label);
    if (wrong) return { cls: 'contradicts', extra: flag(wrong) };
    if (changeText && value !== compared) return { cls: 'changed', extra: h('span', { class: 'tag' }, changeText) };
    return { cls: null, extra: null };
  };
  const legendFlag = () =>
    h('span', {}, h('span', { class: 'flag' }, '✕ Expected … (inferred)'), 'The observed value does not match Total = Unit price × Quantity (one item, no discounts, tax or shipping).');

  // Default pair: the observations just before and after the problem the
  // evidence shows; otherwise the first and last observation.
  const pairFromFinding = finding && finding.before && finding.after && finding.before !== finding.after;
  const defaultBefore = pairFromFinding ? finding.before : observations[0].id;
  const defaultAfter = pairFromFinding ? finding.after : observations.at(-1).id;

  const options = (selected) =>
    observations.map((o) => h('option', { value: o.id, selected: o.id === selected }, `${labels.of(o.id)} (${o.id})`));
  const beforeSelect = h('select', { id: 'cmp-before' }, options(defaultBefore));
  const afterSelect = h('select', { id: 'cmp-after' }, options(defaultAfter));
  const pair = h('div', { class: 'pair zoomed' });
  const caption = h('p', { class: 'compare-caption', 'aria-live': 'polite' });
  const pairLegend = h('div', { class: 'legend pair-legend' });

  // Display-only zoom; the screenshot files are never altered.
  const zoomButton = (zoomed, text) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(zoomed === true),
      onclick: (event) => {
        pair.classList.toggle('zoomed', zoomed);
        for (const b of event.currentTarget.parentElement.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === event.currentTarget));
      },
    }, text);
  const viewToggle = h('div', { class: 'view-toggle', role: 'group', 'aria-label': 'Screenshot view' }, zoomButton(true, 'Top of page'), zoomButton(false, 'Whole screenshot'));

  // Describes the pair actually selected, so it stays true when the menus change.
  const describePair = (b, a) => {
    const parts = [
      b.id === a.id
        ? `Both sides show “${labels.of(a.id)}” (${a.id}).`
        : `Comparing “${labels.of(b.id)}” (${b.id}) with “${labels.of(a.id)}” (${a.id}).`,
    ];
    if (observations.length === 1) return [...parts, 'Only one observation was recorded.'].join(' ');
    if (position(b) > position(a)) parts.push('Before is a later step than After.');
    if (finding?.kind === 'total_not_updated' && b.id === finding.before && a.id === finding.after && b.id !== a.id) {
      parts.push('These are the steps immediately before and after the total first stopped matching the inferred expectation.');
    }
    if (!pricing?.applies) {
      parts.push(`No pricing expectation was checked for this run${pricing?.why ? `: ${pricing.why}` : ''}.`);
      return parts.join(' ');
    }
    const shown = b.id === a.id ? [a] : [b, a];
    const wrong = shown.map((o) => contradiction(o, 'Total')).filter(Boolean);
    if (wrong.length) {
      for (const w of wrong) {
        parts.push(`In ${w.observation}, Total ${w.total} does not match the inferred ${w.expectedTotal} (Unit price ${w.unitPrice} × Quantity ${w.quantity}).`);
      }
    } else {
      parts.push(`${shown.length === 1 ? 'Its total matches' : 'Both totals match'} the inferred expectation (Total = Unit price × Quantity).`);
    }
    return parts.join(' ');
  };
  const figure = (o, other, role) =>
    h(
      'figure',
      { class: 'shot', 'data-role': role, 'data-observation': o.id, 'data-label': labels.of(o.id) },
      h('figcaption', { class: 'shot-title' }, h('span', { class: 'side' }, role), h('strong', { class: 'step' }, labels.of(o.id))),
      h('a', { class: 'shot-frame', href: shotUrl(runId, o.screenshot), target: '_blank', rel: 'noopener', 'aria-label': `Open the full ${role} screenshot (${o.id})` }, h('img', { src: shotUrl(runId, o.screenshot), alt: `${role}: ${labels.of(o.id)}` })),
      h(
        'dl',
        { class: 'observed' },
        o.fields.map((f) => {
          // The After side is compared with the selected Before step, which
          // need not be the previous step; identical selections show no change.
          const m = marked(o, f.label, f.value, valueOf(other, f.label), role === 'After' && other.id !== o.id ? 'different from Before' : null);
          return [h('dt', {}, f.label), h('dd', { class: m.cls }, h('span', { class: 'value' }, f.value), m.extra)];
        }),
      ),
      h('p', { class: 'shot-foot' }, `Observed values · ${o.id} · `, h('a', { href: shotUrl(runId, o.screenshot), target: '_blank', rel: 'noopener' }, 'Open full screenshot')),
    );
  const renderPair = () => {
    const b = observations.find((o) => o.id === beforeSelect.value);
    const a = observations.find((o) => o.id === afterSelect.value);
    pair.replaceChildren(figure(b, a, 'Before'), figure(a, b, 'After'));
    caption.textContent = describePair(b, a);
    // The legend explains only markings this comparison actually shows.
    const shown = [b, a].some((o) => contradiction(o, 'Total'));
    pairLegend.replaceChildren(...(shown ? [legendFlag()] : []));
    pairLegend.hidden = !shown;
  };
  beforeSelect.addEventListener('change', renderPair);
  afterSelect.addEventListener('change', renderPair);
  renderPair();

  let tableHasFlag = false;
  let tableHasChange = false;
  const table = h(
    'table',
    { class: 'obs' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, 'Value'),
        observations.map((o) => h('th', { scope: 'col', id: o.id }, h('div', {}, labels.of(o.id)), h('div', { class: 'obs-id' }, o.id))),
      ),
    ),
    h(
      'tbody',
      {},
      fieldLabels.map((label) =>
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, label),
          observations.map((o, i) => {
            const value = valueOf(o, label);
            const previous = i > 0 ? valueOf(observations[i - 1], label) : undefined;
            const cited = citation(o, label);
            // The table compares each step with the step just before it.
            const m = marked(o, label, value, previous, i > 0 ? 'changed since previous step' : null);
            if (m.cls === 'contradicts') tableHasFlag = true;
            if (m.cls === 'changed') tableHasChange = true;
            return h(
              'td',
              { class: m.cls },
              value ?? h('span', { class: 'muted' }, '—'),
              cited ? h('span', { class: cited.ok ? 'cited' : 'cited bad' }, cited.ok ? 'cited ✓' : 'cited ✗') : null,
              m.extra,
            );
          }),
        ),
      ),
    ),
  );
  const citedAny = record.evidence.length > 0;

  return h(
    'section',
    { class: 'panel evidence', 'data-section': 'evidence' },
    h('h2', {}, 'Before and after'),
    caption,
    h(
      'div',
      { class: 'compare-controls' },
      h('div', { class: 'control' }, h('label', { for: 'cmp-before' }, 'Before'), beforeSelect),
      h('div', { class: 'control' }, h('label', { for: 'cmp-after' }, 'After'), afterSelect),
      viewToggle,
    ),
    pair,
    pairLegend,
    h(
      'div',
      { class: 'values-head' },
      h('h3', {}, 'All observed values'),
      h('p', { class: 'small muted' }, 'Values Repro read from the page after each step. These are recorded observations, not model statements.'),
    ),
    h('div', { class: 'table-wrap' }, table),
    h('p', { class: 'scroll-hint' }, 'Scroll sideways to see every step.'),
    tableHasFlag || tableHasChange || citedAny
      ? h(
          'div',
          { class: 'legend table-legend' },
          tableHasChange ? h('span', {}, h('span', { class: 'tag' }, 'changed since previous step'), 'The value differs from the column to its left.') : null,
          tableHasFlag ? legendFlag() : null,
          citedAny ? h('span', {}, 'cited ✓ = the model cited this value and it matched') : null,
        )
      : null,
  );
}

function actionsCard(record, labels) {
  const describe = (a) => {
    if (a.kind === 'open') return 'Opened the store page';
    return `Clicked ${a.target?.role ?? ''} “${a.target?.name ?? ''}”`;
  };
  return h(
    'section',
    { class: 'panel', 'data-section': 'steps' },
    h('h2', {}, 'Steps the investigator took'),
    record.actions.length
      ? h(
          'ol',
          { class: 'actions' },
          record.actions.map((a) =>
            h(
              'li',
              {},
              h(
                'div',
                {},
                describe(a),
                a.ok ? '' : h('span', { class: 'status-bad' }, ` — failed: ${a.error}`),
                a.afterObservation ? [' → ', h('a', { href: `#${a.afterObservation}` }, labels.of(a.afterObservation))] : null,
                h('span', { class: 'ids' }, `${a.id}${a.afterObservation ? ` → ${a.afterObservation}` : ''}`),
                a.settleWarning ? h('div', { class: 'small muted' }, `Page did not fully settle: ${a.settleWarning}`) : null,
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No browser actions were recorded.'),
  );
}

function modelCard(record) {
  const { expectation } = record;
  const report = record.modelReport;
  return h(
    'details',
    { class: 'card', 'data-section': 'model' },
    h('summary', {}, 'What the model assumed and reported', h('span', { class: 'summary-meta' }, 'unchecked model text')),
    h(
      'div',
      { class: 'details-body' },
      h('p', { class: 'small muted attribution' }, 'The model’s own words, shown as written. Repro has not checked them, and they are not findings.'),
      h('div', { class: 'source-tag' }, expectation.supplied ? 'Expected behavior · supplied by you' : 'Expected behavior · inferred by the model (not stated in the report)'),
      h('p', { class: expectation.supplied || expectation.testedAgainst ? 'prose' : 'muted' }, expectation.supplied ?? expectation.testedAgainst ?? 'Not recorded: no report was submitted.'),
      expectation.supplied && expectation.testedAgainst && expectation.testedAgainst !== expectation.supplied
        ? [h('div', { class: 'source-tag' }, 'Model tested against'), h('p', { class: 'prose' }, expectation.testedAgainst)]
        : null,
      h('div', { class: 'source-tag' }, 'Assumptions the model made'),
      expectation.modelAssumptions.length
        ? h('ul', { class: 'plain' }, expectation.modelAssumptions.map((a) => h('li', {}, a)))
        : h('p', { class: 'muted' }, 'None listed.'),
      report
        ? [
            h('div', { class: 'source-tag' }, 'Observed behavior (as stated by the model)'),
            h('p', { class: 'prose' }, report.observed_behavior),
            h('div', { class: 'source-tag' }, 'Explanation (as stated by the model)'),
            h('p', { class: 'prose' }, report.explanation),
            report.inconclusive_reason ? [h('div', { class: 'source-tag' }, 'Why inconclusive'), h('p', { class: 'prose' }, report.inconclusive_reason)] : null,
          ]
        : h('p', { class: 'muted' }, 'No report was submitted.'),
    ),
  );
}

function citationsCard(record, labels) {
  const matched = record.evidence.filter((c) => c.ok).length;
  return h(
    'details',
    { class: 'card', 'data-section': 'citations' },
    h('summary', {}, `Citation checks (${matched}/${record.evidence.length} matched the recorded page)`),
    h(
      'div',
      { class: 'details-body' },
      record.evidence.length
        ? h(
            'ul',
            { class: 'citations' },
            record.evidence.map((c) =>
              h(
                'li',
                {},
                h('span', { class: c.ok ? 'status-ok' : 'status-bad' }, c.ok ? '✓ matches ' : '✗ mismatch '),
                h('a', { href: `#${c.observation_id}` }, labels.of(c.observation_id)),
                h('span', { class: 'small muted' }, ` (${c.observation_id}) `),
                h('span', { class: 'mono' }, `${c.label}: ${c.value}`),
                c.problem ? h('div', { class: 'small status-bad' }, c.problem) : null,
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'The model cited no evidence.'),
    ),
  );
}

function detailsCard(record) {
  const u = record.usage;
  const rows = [
    ['Provider', record.provider],
    ['Model', record.settings.model],
    ['Duration', fmtSeconds(record.durationMs)],
    ['Browser tool calls', `${record.browserToolCalls} of ${record.settings.maxBrowserToolCalls}`],
    ['Model requests', `${record.providerCalls.length} (${record.providerCalls.filter((c) => !c.ok).length} failed)`],
    ['Tokens', `${u.inputTokens.toLocaleString()} input · ${u.outputTokens.toLocaleString()} output · ${u.cacheReadInputTokens} cache read · ${u.cacheCreationInputTokens} cache write`],
    ['End reason', record.endReason],
    ['Store origin', record.input.storeOrigin],
    ['Cleanup', `context closed ${record.cleanup.contextClosed}, browser closed ${record.cleanup.browserClosed}`],
  ];
  return h(
    'details',
    { class: 'card', 'data-section': 'run-details' },
    h('summary', {}, 'Model, usage and run details', h('span', { class: 'summary-meta' }, `${record.settings.model} · ${(u.inputTokens + u.outputTokens).toLocaleString()} tokens`)),
    h(
      'div',
      { class: 'details-body' },
      h('dl', { class: 'details' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      record.toolErrors.length ? [h('h3', { class: 'source-tag' }, 'Tool errors'), h('ul', { class: 'plain' }, record.toolErrors.map((e) => h('li', {}, `${e.id} (${e.tool}, ${e.kind}): ${e.message}`)))] : null,
      record.providerCalls.some((c) => !c.ok)
        ? [h('h3', { class: 'source-tag' }, 'Failed model requests'), h('ul', { class: 'plain' }, record.providerCalls.filter((c) => !c.ok).map((c) => h('li', {}, `${c.id} attempt ${c.attempt}: ${c.error?.kind ?? ''} ${c.error?.status ?? ''} ${c.error?.message ?? ''}`)))]
        : null,
      record.blockedRequests.length ? [h('h3', { class: 'source-tag' }, 'Blocked requests'), h('ul', { class: 'plain' }, record.blockedRequests.map((b) => h('li', {}, `${b.kind}: ${b.url}`)))] : null,
    ),
  );
}

route();
