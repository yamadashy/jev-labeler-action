import type { LabelRunResult } from './core/run.js';
import type { LabelSubject, RowStatus } from './core/types.js';

/**
 * The job summary.
 *
 * This table is the product in dry-run mode: it is where a maintainer sees what
 * every label scored and decides whether the threshold or the label descriptions
 * need work. It is rendered as a string so it can be asserted in a test.
 */

const STATUS_TEXT: Record<RowStatus, string> = {
  applied: 'applied',
  'applied-as-fallback': 'applied (fallback)',
  'already-present': 'skipped — already on the issue',
  excluded: 'skipped — excluded',
  'not-allowlisted': 'skipped — not in `labels`',
  'below-threshold': 'skipped — below threshold',
  'no-answer': 'skipped — no answer returned',
};

/** Evaluated rows first, highest probability on top; skipped rows after, by name. */
function sortRows(rows: LabelRunResult['rows']): LabelRunResult['rows'] {
  return [...rows].sort((a, b) => {
    if (a.probability === null && b.probability === null) return a.label.localeCompare(b.label);
    if (a.probability === null) return 1;
    if (b.probability === null) return -1;
    return b.probability - a.probability;
  });
}

export function renderSummary(
  result: LabelRunResult,
  subject: LabelSubject,
  threshold: number,
  dryRun: boolean,
): string {
  const lines: string[] = [];

  lines.push(`## Jev Labeler${dryRun ? ' (dry run)' : ''}`);
  lines.push('');
  const noun = subject.kind === 'pull_request' ? 'Pull request' : 'Issue';
  lines.push(`${noun} #${subject.number}: ${escapeCell(subject.title)}`);
  lines.push('');

  if (result.skippedReason === 'bot-author') {
    lines.push(
      `Skipped: ${noun.toLowerCase()} #${subject.number} was opened by \`${escapeCell(subject.author.login)}\`, ` +
        'which is an app. Bot-authored work is boilerplate rather than a report, so nothing was evaluated. ' +
        'Set `skip-bots: false` to label it anyway.',
    );
    lines.push('');
    return lines.join('\n');
  }

  lines.push(
    dryRun
      ? `Nothing was applied. These are the labels that **would** be applied at a threshold of ${threshold}.`
      : result.applied.length > 0
        ? `Applied: ${result.applied.map((label) => `\`${label}\``).join(', ')}`
        : 'No label reached the threshold, so nothing was applied.',
  );
  lines.push('');
  lines.push('| Label | Probability | Threshold | Result |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of sortRows(result.rows)) {
    const probability = row.probability === null ? '—' : row.probability.toFixed(2);
    const shown = row.probability === null ? '—' : String(threshold);
    lines.push(`| \`${escapeCell(row.label)}\` | ${probability} | ${shown} | ${STATUS_TEXT[row.status]} |`);
  }
  lines.push('');
  lines.push(
    `Model \`${result.model}\` · ${result.evaluatedCount} label(s) evaluated · ${result.ms} ms · ` +
      `${result.usage.input_tokens} input tokens, ${result.usage.output_tokens} output tokens`,
  );
  lines.push('');
  return lines.join('\n');
}

/** A label name is arbitrary text and may contain a pipe, which would break the table. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
