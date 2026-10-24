// Repro UI. Plain DOM code; every piece of complaint text, page content and
// model output is inserted with textContent, never parsed as HTML.

const app = document.getElementById('app');
const serverState = document.getElementById('server-state');

const VERDICT_TEXT = {
  reproduced: 'The investigator saw the behavior the complaint describes.',
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
const clock = (startIso, atIso) => {
  const s = Math.max(0, (Date.parse(atIso) - Date.parse(startIso)) / 1000);
  return `+${s.toFixed(1)}s`;
};
const shotUrl = (runId, file) => `/api/runs/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`;
const fieldsText = (fields) => fields.map((f) => `${f.label} ${f.value}`).join(' · ');

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
    h('legend', {}, 'Demo scenario'),
    h('p', { class: 'small muted' }, 'Choose how the demo store behaves for the next investigation. Repro’s investigator is not told which one you picked; it has to find out in the browser.'),
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
        h(
          'span',
          { class: 'scenario-text' },
          h('span', { class: 'scenario-label' }, scenario.label),
          h('span', { class: 'scenario-description' }, scenario.description),
          h('a', { href: scenario.storeUrl, target: '_blank', rel: 'noopener', class: 'small' }, 'Try this store yourself'),
        ),
      ),
    ),
  );
  const selectedScenario = () => scenarioChoices.querySelector('input[name="scenario"]:checked')?.value;

  const form = h(
    'form',
    {
      class: 'card',
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
    h('h1', {}, 'New investigation'),
    scenarioChoices,
    h('label', { for: 'complaint' }, 'Bug report'),
    complaint,
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
      h('summary', {}, 'Expected behavior (optional)'),
      h('label', { for: 'expected', class: 'small' }, 'If you leave this empty, the investigator infers the expectation and lists its assumptions.'),
      expected,
    ),
    h(
      'div',
      { class: 'form-actions' },
      submit,
      h(
        'span',
        { class: 'muted small' },
        status.limits
          ? `Runs in a fresh Chromium browser · up to ${status.limits.maxBrowserToolCalls} browser actions · ${status.limits.deadlineMs / 1000} s`
          : '',
      ),
    ),
    h('p', { class: 'small' }, formError),
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

  const list = runs.length
    ? h(
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
              h('span', { class: 'run-complaint' }, run.complaint, run.scenario ? h('span', { class: 'muted small' }, ` · ${run.scenario.label}`) : null),
              h('span', { class: 'muted small' }, fmtTime(run.startedAt)),
            ),
          ),
        ),
      )
    : h('p', { class: 'muted' }, 'No investigations yet.');

  const intro = h(
    'section',
    { class: 'card intro' },
    h('h1', {}, 'What Repro does'),
    h(
      'p',
      {},
      'Repro takes a bug report written in plain English, tries to reproduce it in a demo store using a real browser, and saves the browser evidence: a screenshot and the values on the page after every step.',
    ),
    h(
      'ol',
      { class: 'how' },
      h('li', {}, 'Pick how the demo store should behave.'),
      h('li', {}, 'Enter a bug report, or use the example.'),
      h('li', {}, 'An AI investigator clicks through the store, then reports Reproduced, Not reproduced in this run, or Inconclusive. Repro checks its claims against what the browser recorded.'),
    ),
  );
  setView(notices, intro, form, h('section', { class: 'card' }, h('h2', {}, 'Recent runs'), list));
  if (!blocked) complaint.focus();
}

function statePill(run) {
  if (run.state === 'finished') return h('span', { class: `pill ${run.verdictCode}` }, run.verdict);
  const label = { running: 'Running', failed: 'Failed', interrupted: 'Interrupted' }[run.state] ?? run.state;
  return h('span', { class: `pill ${run.state}` }, label);
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
  return h('p', {}, h('a', { href: '/', 'data-nav': true }, '← New investigation'));
}

function runHeader(runId, runStatus, setup) {
  const scenario = setup?.scenario ?? runStatus.scenario;
  return h(
    'section',
    { class: 'card', 'data-section': 'report' },
    h('div', { class: 'run-head' }, h('h2', {}, 'Bug report'), h('span', { class: 'muted small mono' }, `${runId} · started ${fmtTime(runStatus.startedAt)}`)),
    h('blockquote', { class: 'complaint' }, runStatus.complaint),
    h(
      'p',
      { class: 'small demo-setup', 'data-scenario': scenario?.id ?? '' },
      h('strong', {}, 'Demo scenario: '),
      scenario
        ? [scenario.label, scenario.description ? h('span', { class: 'muted' }, ` — ${scenario.description}`) : null]
        : h('span', { class: 'muted' }, 'not recorded (this run was made before scenario selection existed).'),
      scenario ? h('div', { class: 'muted' }, 'Chosen by the person running the demo when the run started. The investigator was not told.') : null,
    ),
  );
}

// Live progress: replays recorded events, then follows new ones over SSE.
function showLiveRun(runId, runStatus) {
  const activity = h('ol', { class: 'activity' });
  const elapsed = h('span', {}, '');
  const toolCalls = h('span', {}, '');
  const modelCalls = h('span', {}, '');
  const panel = h(
    'section',
    { class: 'verdict running' },
    h('div', { class: 'kicker' }, 'In progress'),
    h('div', { class: 'verdict-label' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Investigating'),
    h('div', { class: 'counters muted' }, elapsed, toolCalls, modelCalls),
  );
  const connection = h('p', { class: 'small muted' }, 'Showing events as Repro records them.');
  setView(backLink(), runHeader(runId, runStatus), panel, h('section', { class: 'card' }, h('h2', {}, 'Activity'), connection, activity));

  const state = { limits: null, tools: 0, models: 0 };
  const tick = () => {
    elapsed.textContent = `Elapsed ${((Date.now() - Date.parse(runStatus.startedAt)) / 1000).toFixed(0)} s`;
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
    panel.className = 'verdict interrupted';
    panel.replaceChildren(
      h('div', { class: 'kicker' }, 'Connection lost'),
      h('div', { class: 'verdict-label' }, 'Lost contact with the Repro server'),
      h('p', {}, 'The run may have been interrupted. Restart Repro if it stopped, then reload this page to see the saved result.'),
      detail ? h('p', { class: 'small' }, detail) : null,
    );
  };

  const connect = () => {
    activity.replaceChildren();
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
      addActivity(activity, runId, runStatus.startedAt, event);
      if (state.limits) toolCalls.textContent = `Browser tool calls ${state.tools}/${state.limits.maxBrowserToolCalls}`;
      modelCalls.textContent = `Model requests ${state.models}`;
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

function addActivity(list, runId, startIso, event) {
  const item = (what, extra = {}) =>
    h('li', { class: extra.class, 'data-key': extra.key }, h('span', { class: 't' }, clock(startIso, event.at)), h('span', { class: 'what' }, what));
  let node = null;
  switch (event.type) {
    case 'run_started':
      node = item(`Run started · limits: ${event.limits.maxBrowserToolCalls} browser tool calls, ${event.limits.deadlineMs / 1000} s`);
      break;
    case 'action': {
      const a = event.action;
      const what = a.kind === 'open' ? ['Opened ', h('span', { class: 'mono' }, a.url ?? '')] : [`Clicked ${a.target?.role ?? ''} “${a.target?.name ?? ''}”`];
      node = item([`${a.id} · `, ...what, a.ok ? '' : ` — failed: ${a.error}`, a.settleWarning ? ` (page did not fully settle: ${a.settleWarning})` : ''], { class: a.ok ? '' : 'bad' });
      break;
    }
    case 'observation': {
      const o = event.observation;
      node = item([
        `Recorded ${o.id}: `,
        h('strong', {}, fieldsText(o.fields) || 'no labeled values'),
        ' · ',
        h('a', { href: shotUrl(runId, o.screenshot), target: '_blank', rel: 'noopener' }, 'screenshot'),
      ]);
      break;
    }
    case 'model_request_started':
      node = item(`Model request ${event.id}${event.attempt > 1 ? ` (attempt ${event.attempt})` : ''} sent`, { class: 'pending', key: event.id });
      break;
    case 'model_request_finished': {
      const c = event.call;
      const existing = list.querySelector(`li[data-key="${c.id}"]`);
      const text = c.ok
        ? `Model request ${c.id} answered in ${fmtSeconds(c.durationMs)} · ${c.usage.inputTokens.toLocaleString()} in / ${c.usage.outputTokens.toLocaleString()} out tokens`
        : `Model request ${c.id} failed: ${c.error?.kind ?? ''}${c.error?.status ? ` ${c.error.status}` : ''} ${c.error?.message ?? ''}`;
      if (existing) {
        existing.classList.remove('pending');
        if (!c.ok) existing.classList.add('bad');
        existing.querySelector('.what').textContent = text;
        return;
      }
      node = item(text, { class: c.ok ? '' : 'bad' });
      break;
    }
    case 'browser_tool_requested':
      node = item(
        event.target
          ? `Model chose to click ${event.target.role} “${event.target.name}” (${event.elementId} in ${event.target.fromObservation}) · tool call ${event.callNumber}`
          : `Model called ${event.tool}${event.elementId ? ` (${event.elementId})` : ''} · tool call ${event.callNumber}`,
      );
      break;
    case 'tool_error':
      node = item(`Tool error ${event.error.id} (${event.error.tool}): ${event.error.message}`, { class: 'bad' });
      break;
    case 'report_submitted':
      node = item(`Model submitted its report (proposed: ${event.proposedVerdict.replace('_', ' ')}, ${event.citations} citations). Repro checks the evidence.`);
      break;
    case 'run_finished':
      node = item(`Final verdict: ${event.verdict}`);
      break;
    default:
      return;
  }
  list.append(node);
}

function renderFinished(runId, data) {
  const { status: runStatus, record, events, setup, finding } = data;
  const activity = h('ol', { class: 'activity' });
  for (const event of events) addActivity(activity, runId, runStatus.startedAt, event);
  const log = h('details', { class: 'card log', 'data-section': 'activity' }, h('summary', {}, `Activity log (${events.length} recorded events)`), activity);

  if (!record) {
    const label = runStatus.state === 'interrupted' ? 'Interrupted' : 'Failed';
    setView(
      backLink(),
      runHeader(runId, runStatus, setup),
      h(
        'section',
        { class: `verdict ${runStatus.state}` },
        h('div', { class: 'kicker' }, 'No report'),
        h('div', { class: 'verdict-label' }, label),
        h('p', {}, runStatus.error ?? 'The investigation ended without saving a report.'),
        h('p', { class: 'small' }, 'Whatever was recorded before it stopped is in the activity log below.'),
      ),
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
    comparisonCard(runId, record, finding, labels),
    actionsCard(record, labels),
    modelCard(record),
    citationsCard(record, labels),
    detailsCard(record),
    log,
  );
}

const VERDICT_LABEL = { reproduced: 'Reproduced', not_reproduced: 'Not reproduced in this run', inconclusive: 'Inconclusive' };

const DOWNGRADE_TEXT = {
  citation_mismatch: 'Evidence validation failure: a cited value did not match the recorded page.',
  scenario_not_exercised: 'Evidence rule: the report did not show the scenario was exercised.',
  demo_cart_total_equals_unit_price_times_quantity:
    'Contradicted by its own evidence (demo cart pricing rule: Total = Unit price × Quantity, one item, no discounts, tax or shipping).',
};

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
    h('div', { class: 'kicker' }, 'Verdict'),
    h('div', { class: 'verdict-label' }, record.verdict),
    proposed
      ? h('div', { class: 'proposed', 'data-proposed': proposed }, 'Model proposed: ', h('strong', {}, VERDICT_LABEL[proposed] ?? proposed), ' → final verdict: ', h('strong', {}, record.verdict))
      : null,
    allReasons.length ? h('ul', { class: 'reasons' }, allReasons.map((r) => h('li', {}, r))) : null,
    h(
      'div',
      { class: 'summary-box' },
      finding
        ? h(
            'div',
            { class: 'finding', 'data-finding': finding.kind },
            h('span', { class: 'summary-label' }, 'What the browser showed: '),
            finding.text,
            finding.inferredExpectation ? h('div', { class: 'small muted-strong' }, finding.inferredExpectation) : null,
          )
        : null,
      record.coverage
        ? h(
            'div',
            { class: 'coverage', 'data-coverage': true },
            h('span', { class: 'summary-label' }, 'Covered in this run: '),
            record.coverage.summary,
            record.verdictCode === 'not_reproduced'
              ? h('div', { class: 'small muted-strong' }, 'This verdict applies only to the states listed. Values that were never observed were not tested.')
              : null,
          )
        : null,
    ),
    h('div', { class: 'small verdict-note' }, VERDICT_TEXT[record.verdictCode]),
    runStatus.state === 'interrupted' ? h('p', {}, runStatus.error) : null,
  );
}

function comparisonCard(runId, record, finding, labels) {
  const observations = record.observations;
  if (!observations.length) {
    return h('section', { class: 'card' }, h('h2', {}, 'Evidence'), h('p', { class: 'muted' }, 'No observations were recorded.'));
  }
  const fieldLabels = [...new Set(observations.flatMap((o) => o.fields.map((f) => f.label)))];
  const valueOf = (o, label) => o.fields.find((f) => f.label === label)?.value;
  const citation = (o, label) => record.evidence.find((c) => c.observation_id === o.id && c.label === label);

  // Default pair: the observations just before and after the problem the
  // evidence shows; otherwise the first and last observation.
  const pairFromFinding = finding && finding.before && finding.after && finding.before !== finding.after;
  const defaultBefore = pairFromFinding ? finding.before : observations[0].id;
  const defaultAfter = pairFromFinding ? finding.after : observations.at(-1).id;

  const options = (selected) =>
    observations.map((o) => h('option', { value: o.id, selected: o.id === selected }, `${labels.of(o.id)} (${o.id})`));
  const beforeSelect = h('select', { id: 'cmp-before' }, options(defaultBefore));
  const afterSelect = h('select', { id: 'cmp-after' }, options(defaultAfter));
  const pair = h('div', { class: 'grid-2' });
  const figure = (o, other, role) =>
    h(
      'figure',
      { class: 'shot', 'data-role': role, 'data-observation': o.id },
      h('figcaption', { class: 'shot-title' }, h('strong', {}, `${role}: ${labels.of(o.id)}`)),
      h('a', { href: shotUrl(runId, o.screenshot), target: '_blank', rel: 'noopener' }, h('img', { src: shotUrl(runId, o.screenshot), alt: `${role}: ${labels.of(o.id)}` })),
      h(
        'dl',
        {},
        o.fields.map((f) => [h('dt', {}, f.label), h('dd', { class: role === 'After' && valueOf(other, f.label) !== f.value ? 'changed' : null }, f.value)]),
      ),
      h(
        'div',
        { class: 'small muted' },
        `Observation ${o.id} · `,
        h('a', { href: shotUrl(runId, o.screenshot), target: '_blank', rel: 'noopener' }, 'Open full screenshot'),
      ),
    );
  const renderPair = () => {
    const b = observations.find((o) => o.id === beforeSelect.value);
    const a = observations.find((o) => o.id === afterSelect.value);
    pair.replaceChildren(figure(b, a, 'Before'), figure(a, b, 'After'));
  };
  beforeSelect.addEventListener('change', renderPair);
  afterSelect.addEventListener('change', renderPair);
  renderPair();

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
        observations.map((o) => h('th', { scope: 'col', id: o.id }, h('div', {}, labels.of(o.id)), h('div', { class: 'small muted' }, o.id))),
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
            return h(
              'td',
              { class: i > 0 && value !== previous ? 'changed' : null },
              value ?? h('span', { class: 'muted' }, '—'),
              cited ? h('span', { class: cited.ok ? 'cited' : 'cited bad' }, cited.ok ? 'cited ✓' : 'cited ✗') : null,
            );
          }),
        ),
      ),
    ),
  );

  return h(
    'section',
    { class: 'card', 'data-section': 'evidence' },
    h('h2', {}, 'Evidence'),
    h(
      'p',
      { class: 'small muted' },
      pairFromFinding
        ? 'Showing the observations immediately before and after the problem appears. Use the menus to compare any other steps.'
        : 'Showing the first and last observations. Use the menus to compare any other steps.',
    ),
    h('div', { class: 'compare-controls' }, h('span', {}, h('label', { for: 'cmp-before' }, 'Before'), beforeSelect), h('span', {}, h('label', { for: 'cmp-after' }, 'After'), afterSelect)),
    pair,
    h('h3', { class: 'compare-title' }, 'All observed values'),
    h('p', { class: 'small muted' }, 'Values Repro read from the page after each step. These are recorded observations, not model statements.'),
    h('div', { class: 'table-wrap' }, table),
    h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'swatch' }), 'changed from the previous step'), h('span', {}, 'cited ✓ = the model cited this value and it matched')),
  );
}

function actionsCard(record, labels) {
  const describe = (a) => {
    if (a.kind === 'open') return 'Opened the store page';
    return `Clicked ${a.target?.role ?? ''} “${a.target?.name ?? ''}”`;
  };
  return h(
    'section',
    { class: 'card', 'data-section': 'steps' },
    h('h2', {}, 'Steps the investigator took'),
    record.actions.length
      ? h(
          'ol',
          { class: 'actions' },
          record.actions.map((a) =>
            h(
              'li',
              {},
              describe(a),
              a.ok ? '' : h('span', { class: 'status-bad' }, ` — failed: ${a.error}`),
              a.afterObservation ? [' → ', h('a', { href: `#${a.afterObservation}` }, labels.of(a.afterObservation))] : null,
              h('span', { class: 'small muted mono' }, `  ${a.id}${a.afterObservation ? ` → ${a.afterObservation}` : ''}`),
              a.settleWarning ? h('div', { class: 'small muted' }, `Page did not fully settle: ${a.settleWarning}`) : null,
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
    h('summary', {}, 'What the model assumed and reported'),
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
  );
}

function citationsCard(record, labels) {
  const matched = record.evidence.filter((c) => c.ok).length;
  return h(
    'details',
    { class: 'card', 'data-section': 'citations' },
    h('summary', {}, `Citation checks (${matched}/${record.evidence.length} matched the recorded page)`),
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
    h('summary', {}, 'Model, usage and run details'),
    h('dl', { class: 'details' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    record.toolErrors.length ? [h('h3', {}, 'Tool errors'), h('ul', { class: 'plain' }, record.toolErrors.map((e) => h('li', {}, `${e.id} (${e.tool}, ${e.kind}): ${e.message}`)))] : null,
    record.providerCalls.some((c) => !c.ok)
      ? [h('h3', {}, 'Failed model requests'), h('ul', { class: 'plain' }, record.providerCalls.filter((c) => !c.ok).map((c) => h('li', {}, `${c.id} attempt ${c.attempt}: ${c.error?.kind ?? ''} ${c.error?.status ?? ''} ${c.error?.message ?? ''}`)))]
      : null,
    record.blockedRequests.length ? [h('h3', {}, 'Blocked requests'), h('ul', { class: 'plain' }, record.blockedRequests.map((b) => h('li', {}, `${b.kind}: ${b.url}`)))] : null,
  );
}

route();
