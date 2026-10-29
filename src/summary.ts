import { relative } from 'node:path';
import type { RunRecord } from './investigator.ts';

// Human-readable summary of a saved run. Paths are relative to `root`.
export function formatRunSummary(record: RunRecord, root: string): string {
  const dir = relative(root, record.runDir);
  const lines = [
    `Run ${record.runId}  (${dir}/)`,
    `  Provider: ${record.provider}; model: ${record.settings.model}`,
    `  Verdict: ${record.verdict}${record.verdictReasons.length ? ` — ${record.verdictReasons.join(' ')}` : ''}`,
    ...(record.downgrade ? [`  Model proposed: ${record.downgrade.from}; downgraded by ${record.downgrade.rule}`] : []),
    `  Coverage: ${record.coverage.summary}`,
    `  End reason: ${record.endReason}`,
    `  Duration: ${(record.durationMs / 1000).toFixed(1)}s, browser tool calls: ${record.browserToolCalls}/${record.settings.maxBrowserToolCalls}`,
    `  Tokens: input ${record.usage.inputTokens}, output ${record.usage.outputTokens}` +
      `, cache read ${record.usage.cacheReadInputTokens}, cache write ${record.usage.cacheCreationInputTokens}` +
      ` over ${record.providerCalls.length} model request(s)`,
    `  Expected behavior: ${record.expectation.supplied ? `supplied: ${record.expectation.supplied}` : 'none supplied'}`,
  ];
  if (record.expectation.testedAgainst) lines.push(`  Tested against: ${record.expectation.testedAgainst}`);
  for (const assumption of record.expectation.modelAssumptions) lines.push(`  Model assumption: ${assumption}`);
  if (record.modelReport) lines.push(`  Observed (model): ${record.modelReport.observed_behavior}`);
  lines.push('  Actions:');
  for (const a of record.actions) {
    const target = a.target ? ` ${a.target.role} "${a.target.name}" (${a.target.elementId} in ${a.target.fromObservation})` : ` ${a.url}`;
    lines.push(`    ${a.id} ${a.kind}${target} → ${a.ok ? 'ok' : `failed: ${a.error}`}${a.afterObservation ? `, then ${a.afterObservation}` : ''}`);
  }
  lines.push('  Observations:');
  for (const o of record.observations) {
    const fields = o.fields.map((f) => `${f.label}: ${f.value}`).join(' | ');
    lines.push(`    ${o.id} (after ${o.trigger}) ${fields}  [${dir}/${o.screenshot}]`);
  }
  if (record.evidence.length) {
    lines.push('  Cited evidence:');
    for (const c of record.evidence) {
      lines.push(`    ${c.ok ? 'ok  ' : 'BAD '} ${c.observation_id} "${c.label}: ${c.value}"${c.problem ? ` — ${c.problem}` : ''}`);
    }
  }
  for (const e of record.toolErrors) lines.push(`  Tool error ${e.id} (${e.tool}, ${e.kind}): ${e.message}`);
  for (const b of record.blockedRequests) lines.push(`  Blocked ${b.kind}: ${b.url}`);
  for (const c of record.providerCalls.filter((call) => !call.ok)) {
    lines.push(`  Model request ${c.id} attempt ${c.attempt} failed: ${c.error?.kind} ${c.error?.status ?? ''} ${c.error?.message}`);
  }
  lines.push(`  Cleanup: context closed ${record.cleanup.contextClosed}, browser closed ${record.cleanup.browserClosed}`);
  return lines.join('\n');
}
