import { describe, expect, it } from 'vitest';
import type { LabelRunResult } from '../src/core/run.js';
import type { LabelSubject } from '../src/core/types.js';
import { renderSummary } from '../src/summary.js';

const subject: LabelSubject = {
  kind: 'issue',
  number: 3,
  title: 'A | B fails',
  body: '',
  labels: [],
  author: { login: 'octocat', isBot: false },
};

const result: LabelRunResult = {
  applied: ['bug'],
  probabilities: { bug: 0.93, question: 0.04 },
  rows: [
    { label: 'question', probability: 0.04, status: 'below-threshold' },
    { label: 'bug', probability: 0.93, status: 'applied' },
    { label: 'triage', probability: null, status: 'no-condition' },
  ],
  model: 'jev-1.13.0',
  ms: 412,
  usage: { input_tokens: 900, output_tokens: 60 },
  evaluatedCount: 2,
};

describe('renderSummary', () => {
  it('lists every evaluated label, highest probability first', () => {
    const markdown = renderSummary(result, subject, 0.8, false);
    const rows = markdown.split('\n').filter((line) => line.startsWith('| `'));
    expect(rows[0]).toContain('`bug`');
    expect(rows[1]).toContain('`question`');
    expect(rows[2]).toContain('`triage`');
  });

  it('shows the probability, the threshold and the outcome', () => {
    const markdown = renderSummary(result, subject, 0.8, false);
    expect(markdown).toContain('| `bug` | 0.93 | 0.8 | applied |');
    expect(markdown).toContain('| `question` | 0.04 | 0.8 | skipped — below threshold |');
  });

  it('reports the model, latency and tokens', () => {
    const markdown = renderSummary(result, subject, 0.8, false);
    expect(markdown).toContain('jev-1.13.0');
    expect(markdown).toContain('412 ms');
    expect(markdown).toContain('900 input tokens');
  });

  it('says plainly that a dry run applied nothing', () => {
    const markdown = renderSummary(result, subject, 0.8, true);
    expect(markdown).toContain('(dry run)');
    expect(markdown).toContain('Nothing was applied');
  });

  it('explains a bot skip instead of printing an empty table', () => {
    const markdown = renderSummary(
      { ...result, applied: [], rows: [], evaluatedCount: 0, skippedReason: 'bot-author' },
      { ...subject, author: { login: 'renovate[bot]', isBot: true } },
      0.8,
      false,
    );
    expect(markdown).toContain('renovate[bot]');
    expect(markdown).toContain('skip-bots');
    expect(markdown).not.toContain('| Label |');
  });

  it('calls a pull request a pull request', () => {
    const markdown = renderSummary(result, { ...subject, kind: 'pull_request' }, 0.8, false);
    expect(markdown).toContain('Pull request #3');
    expect(markdown).not.toContain('Issue #3');
  });

  it('escapes a pipe in a label or title so the table survives', () => {
    const markdown = renderSummary(
      { ...result, rows: [{ label: 'a|b', probability: 0.5, status: 'below-threshold' }] },
      subject,
      0.8,
      false,
    );
    expect(markdown).toContain('`a\\|b`');
    expect(markdown).toContain('A \\| B fails');
  });
});
