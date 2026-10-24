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
            body: JSON.stringify({ complaint: complaint.value, expectedBehavior: expected.value }),
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
    h('label', { for: 'complaint' }, 'Complaint'),
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
        'Target: ',
        h('a', { href: status.storeUrl, target: '_blank', rel: 'noopener' }, status.storeUrl),
        status.limits ? ` · fresh Chromium · up to ${status.limits.maxBrowserToolCalls} browser tool calls · ${status.limits.deadlineMs / 1000} s` : '',
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
              h('span', { class: 'run-complaint' }, run.complaint),
              h('span', { class: 'muted small' }, fmtTime(run.startedAt)),
            ),
          ),
        ),
      )
    : h('p', { class: 'muted' }, 'No investigations yet.');

  setView(notices, form, h('section', { class: 'card' }, h('h2', {}, 'Recent runs'), list));
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

function runHeader(runId, runStatus) {
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'run-head' }, h('h1', {}, 'Complaint'), h('span', { class: 'muted small mono' }, `${runId} · started ${fmtTime(runStatus.startedAt)}`)),
    h('blockquote', { class: 'complaint' }, runStatus.complaint),
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
  const { status: runStatus, record, events } = data;
  const activity = h('ol', { class: 'activity' });
  for (const event of events) addActivity(activity, runId, runStatus.startedAt, event);
  const log = h('details', { class: 'card log' }, h('summary', {}, `Activity log (${events.length} recorded events)`), activity);

  if (!record) {
    const label = runStatus.state === 'interrupted' ? 'Interrupted' : 'Failed';
    setView(
      backLink(),
      runHeader(runId, runStatus),
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

  setView(
    backLink(),
    record.provider.startsWith('TEST DOUBLE')
      ? h('div', { class: 'banner-double' }, `This run used a scripted test double, not a real model (${record.provider}). It verifies the UI and pipeline only.`)
      : null,
    runHeader(runId, runStatus),
    verdictPanel(record, runStatus),
    h('div', { class: 'grid-2' }, expectationCard(record), modelAccountCard(record)),
    comparisonCard(runId, record),
    actionsCard(record),
    detailsCard(record),
    log,
  );
}

function verdictPanel(record, runStatus) {
  const reasons = [];
  const endText = END_REASON_TEXT[record.endReason];
  if (endText) reasons.push(endText);
  const badEvidence = record.evidence.some((c) => !c.ok);
  if (record.endReason === 'report_submitted' && record.modelReport && record.verdictCode !== record.modelReport.verdict) {
    reasons.push(
      `${badEvidence ? 'Evidence validation failure' : 'Evidence rule'}: Repro downgraded the model's proposed verdict (${record.modelReport.verdict.replace('_', ' ')}) to Inconclusive.`,
    );
  }
  return h(
    'section',
    { class: `verdict ${record.verdictCode}`, 'data-verdict': record.verdictCode },
    h('div', { class: 'kicker' }, 'Verdict'),
    h('div', { class: 'verdict-label' }, record.verdict),
    h('div', {}, VERDICT_TEXT[record.verdictCode]),
    reasons.length || record.verdictReasons.length ? h('ul', {}, [...reasons, ...record.verdictReasons].map((r) => h('li', {}, r))) : null,
    runStatus.state === 'interrupted' ? h('p', {}, runStatus.error) : null,
  );
}

function expectationCard(record) {
  const { expectation } = record;
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'What was tested'),
    h('div', { class: 'source-tag' }, expectation.supplied ? 'Expected behavior · supplied by you' : 'Expected behavior · inferred by the model'),
    h('p', { class: expectation.supplied || expectation.testedAgainst ? 'prose' : 'muted' }, expectation.supplied ?? expectation.testedAgainst ?? 'Not recorded: no report was submitted.'),
    expectation.supplied && expectation.testedAgainst && expectation.testedAgainst !== expectation.supplied
      ? [h('div', { class: 'source-tag' }, 'Model tested against'), h('p', { class: 'prose' }, expectation.testedAgainst)]
      : null,
    h('div', { class: 'source-tag' }, 'Assumptions the model made'),
    expectation.modelAssumptions.length
      ? h('ul', { class: 'plain' }, expectation.modelAssumptions.map((a) => h('li', {}, a)))
      : h('p', { class: 'muted' }, 'None listed.'),
  );
}

function modelAccountCard(record) {
  const report = record.modelReport;
  if (!report) {
    return h('section', { class: 'card' }, h('h2', {}, "Model's account"), h('p', { class: 'muted' }, 'No report was submitted.'));
  }
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, "Model's account"),
    h('div', { class: 'source-tag' }, 'Observed behavior (as stated by the model)'),
    h('p', { class: 'prose' }, report.observed_behavior),
    h('div', { class: 'source-tag' }, 'Explanation (as stated by the model)'),
    h('p', { class: 'prose' }, report.explanation),
    report.inconclusive_reason ? [h('div', { class: 'source-tag' }, 'Why inconclusive'), h('p', { class: 'prose' }, report.inconclusive_reason)] : null,
    h('div', { class: 'source-tag' }, `Cited evidence · checked by Repro (${record.evidence.filter((c) => c.ok).length}/${record.evidence.length} match)`),
    h(
      'ul',
      { class: 'citations' },
      record.evidence.map((c) =>
        h(
          'li',
          {},
          h('span', { class: c.ok ? 'status-ok' : 'status-bad' }, c.ok ? '✓ matches ' : '✗ mismatch '),
          h('a', { href: `#${c.observation_id}` }, c.observation_id),
          ' ',
          h('span', { class: 'mono' }, `${c.label}: ${c.value}`),
          c.problem ? h('div', { class: 'small status-bad' }, c.problem) : null,
        ),
      ),
    ),
  );
}

function comparisonCard(runId, record) {
  const observations = record.observations;
  if (!observations.length) {
    return h('section', { class: 'card' }, h('h2', {}, 'Before and after'), h('p', { class: 'muted' }, 'No observations were recorded.'));
  }
  const labels = [...new Set(observations.flatMap((o) => o.fields.map((f) => f.label)))];
  const valueOf = (o, label) => o.fields.find((f) => f.label === label)?.value;
  const citation = (o, label) => record.evidence.find((c) => c.observation_id === o.id && c.label === label);
  const actionFor = (o) => record.actions.find((a) => a.id === o.trigger);
  const caption = (o) => {
    const a = actionFor(o);
    if (!a) return `after ${o.trigger}`;
    return a.kind === 'open' ? 'after opening the page' : `after clicking “${a.target?.name ?? ''}”`;
  };

  const table = h(
    'table',
    { class: 'obs' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, 'Label'),
        observations.map((o) =>
          h(
            'th',
            { scope: 'col', id: o.id },
            h('div', {}, o.id),
            h('div', { class: 'small muted' }, caption(o)),
            h('a', { href: shotUrl(runId, o.screenshot), target: '_blank', rel: 'noopener', title: `Open ${o.screenshot}` }, h('img', { src: shotUrl(runId, o.screenshot), alt: `Screenshot ${o.id}`, loading: 'lazy' })),
          ),
        ),
      ),
    ),
    h(
      'tbody',
      {},
      labels.map((label) =>
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

  // Side-by-side screenshots, defaulting to the first and last observation.
  const options = (selected) => observations.map((o) => h('option', { value: o.id, selected: o.id === selected }, `${o.id} · ${caption(o)}`));
  const beforeSelect = h('select', { id: 'cmp-before' }, options(observations[0].id));
  const afterSelect = h('select', { id: 'cmp-after' }, options(observations.at(-1).id));
  const pair = h('div', { class: 'grid-2' });
  const figure = (o, other, role) =>
    h(
      'figure',
      { class: 'shot', 'data-role': role },
      h('a', { href: shotUrl(runId, o.screenshot), target: '_blank', rel: 'noopener' }, h('img', { src: shotUrl(runId, o.screenshot), alt: `${role} screenshot ${o.id}` })),
      h(
        'figcaption',
        {},
        h('strong', {}, `${role}: ${o.id}`),
        ` · ${caption(o)}`,
        h('dl', {}, o.fields.map((f) => [h('dt', {}, f.label), h('dd', { class: role === 'After' && valueOf(other, f.label) !== f.value ? 'changed' : null }, f.value)])),
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

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Before and after'),
    h('p', { class: 'small muted' }, 'Values Repro read from the page after each step. These are recorded observations, not model statements.'),
    h('div', { class: 'table-wrap' }, table),
    h('div', { class: 'legend' }, h('span', {}, h('span', { class: 'swatch' }), 'changed from previous observation'), h('span', {}, 'cited ✓ = the model cited this value and it matched')),
    observations.length > 1
      ? [
          h('h3', { class: 'compare-title' }, 'Compare screenshots'),
          h('div', { class: 'compare-controls' }, h('span', {}, h('label', { for: 'cmp-before' }, 'Before'), beforeSelect), h('span', {}, h('label', { for: 'cmp-after' }, 'After'), afterSelect)),
          pair,
        ]
      : h('p', { class: 'muted small' }, 'Only one observation was recorded, so there is nothing to compare.'),
  );
}

function actionsCard(record) {
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Actions'),
    record.actions.length
      ? h(
          'ol',
          { class: 'actions' },
          record.actions.map((a) =>
            h(
              'li',
              {},
              h('span', { class: 'mono muted' }, `${a.id} `),
              a.kind === 'open'
                ? ['Opened ', h('span', { class: 'mono' }, a.url ?? '')]
                : [`Clicked ${a.target?.role} “${a.target?.name}” `, h('span', { class: 'muted' }, `(${a.target?.elementId} in `), h('a', { href: `#${a.target?.fromObservation}` }, a.target?.fromObservation), h('span', { class: 'muted' }, ')')],
              ' → ',
              a.ok ? h('span', { class: 'status-ok' }, 'ok') : h('span', { class: 'status-bad' }, `failed: ${a.error}`),
              a.afterObservation ? [', then ', h('a', { href: `#${a.afterObservation}` }, a.afterObservation)] : null,
              a.settleWarning ? h('div', { class: 'small muted' }, `Page did not fully settle: ${a.settleWarning}`) : null,
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No browser actions were recorded.'),
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
    'section',
    { class: 'card' },
    h('h2', {}, 'Run details'),
    h('dl', { class: 'details' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    record.toolErrors.length ? [h('h3', {}, 'Tool errors'), h('ul', { class: 'plain' }, record.toolErrors.map((e) => h('li', {}, `${e.id} (${e.tool}, ${e.kind}): ${e.message}`)))] : null,
    record.providerCalls.some((c) => !c.ok)
      ? [h('h3', {}, 'Failed model requests'), h('ul', { class: 'plain' }, record.providerCalls.filter((c) => !c.ok).map((c) => h('li', {}, `${c.id} attempt ${c.attempt}: ${c.error?.kind ?? ''} ${c.error?.status ?? ''} ${c.error?.message ?? ''}`)))]
      : null,
    record.blockedRequests.length ? [h('h3', {}, 'Blocked requests'), h('ul', { class: 'plain' }, record.blockedRequests.map((b) => h('li', {}, `${b.kind}: ${b.url}`)))] : null,
  );
}

route();
