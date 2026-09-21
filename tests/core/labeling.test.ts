import { describe, expect, it } from 'vitest';
import { buildPlan, buildState, decide, truncate, zeroConfigInstructions } from '../../src/core/labeling.js';
import type { LabelSubject, RepoLabel } from '../../src/core/types.js';

const repoLabels: RepoLabel[] = [
  { name: 'bug', description: "Something isn't working" },
  { name: 'enhancement', description: 'New feature or request' },
  { name: 'triage', description: null },
  { name: 'duplicate', description: 'This issue or pull request already exists' },
];

const subject = (overrides: Partial<LabelSubject> = {}): LabelSubject => ({
  kind: 'issue',
  number: 7,
  title: 'The CLI crashes on a brace glob',
  body: 'Steps to reproduce follow.',
  labels: [],
  author: { login: 'octocat', isBot: false },
  ...overrides,
});

describe('buildPlan', () => {
  it('asks one question per label that has a description', () => {
    const plan = buildPlan({ repoLabels, subject: subject() });

    expect(plan.planned.map((entry) => entry.label)).toEqual(['bug', 'enhancement', 'duplicate']);
    expect(Object.keys(plan.questions)).toEqual(['l0', 'l1', 'l2']);
    expect(plan.idToLabel).toEqual({ l0: 'bug', l1: 'enhancement', l2: 'duplicate' });
  });

  it('skips a label with no description and says why', () => {
    const plan = buildPlan({ repoLabels, subject: subject() });
    expect(plan.skipped).toContainEqual({ label: 'triage', probability: null, status: 'no-condition' });
  });

  it('uses the measured zero-config wording, carrying the name and the description', () => {
    const plan = buildPlan({ repoLabels: [repoLabels[0]], subject: subject() });
    expect(plan.questions.l0).toEqual({
      type: 'noul',
      instructions: zeroConfigInstructions('bug', "Something isn't working"),
    });
    expect(plan.questions.l0.instructions).toContain('"bug"');
    expect(plan.questions.l0.instructions).toContain("Something isn't working");
  });

  it('sends a hand-written condition as the whole question', () => {
    const plan = buildPlan({
      repoLabels: [repoLabels[0]],
      subject: subject(),
      criteria: { bug: 'The author reports that the tool misbehaves.' },
    });
    expect(plan.questions.l0).toEqual({ type: 'noul', instructions: 'The author reports that the tool misbehaves.' });
  });

  it('keeps digits out of the wording the action controls', () => {
    const plan = buildPlan({ repoLabels: [repoLabels[0]], subject: subject() });
    const boilerplate = zeroConfigInstructions('', '');
    expect(boilerplate).not.toMatch(/\d/);
    expect(plan.questions.l0.instructions).not.toMatch(/\d/);
  });

  it('never asks about a label the issue already has', () => {
    const plan = buildPlan({ repoLabels, subject: subject({ labels: ['Bug'] }) });
    expect(plan.planned.map((entry) => entry.label)).not.toContain('bug');
    expect(plan.skipped).toContainEqual({ label: 'bug', probability: null, status: 'already-present' });
  });

  it('honours the exclude list case-insensitively', () => {
    const plan = buildPlan({ repoLabels, subject: subject(), excludes: ['DUPLICATE'] });
    expect(plan.planned.map((entry) => entry.label)).toEqual(['bug', 'enhancement']);
    expect(plan.skipped).toContainEqual({ label: 'duplicate', probability: null, status: 'excluded' });
  });

  it('restricts to the allowlist when one is given', () => {
    const plan = buildPlan({ repoLabels, subject: subject(), allowlist: ['bug'] });
    expect(plan.planned.map((entry) => entry.label)).toEqual(['bug']);
    expect(plan.skipped).toContainEqual({ label: 'enhancement', probability: null, status: 'not-allowlisted' });
  });

  it('lets criteria bring in a label with no description', () => {
    const plan = buildPlan({
      repoLabels,
      subject: subject(),
      criteria: { triage: 'needs a maintainer to look at it' },
    });
    const triage = plan.planned.find((entry) => entry.label === 'triage');
    expect(triage?.condition).toBe('needs a maintainer to look at it');
  });

  it('lets criteria override a GitHub description', () => {
    const plan = buildPlan({
      repoLabels,
      subject: subject(),
      criteria: { Bug: 'reports a defect in shipped behaviour' },
    });
    const bug = plan.planned.find((entry) => entry.label === 'bug');
    expect(bug?.condition).toBe('reports a defect in shipped behaviour');
  });

  it('opts a label in through criteria even when an allowlist excludes it', () => {
    const plan = buildPlan({
      repoLabels,
      subject: subject(),
      allowlist: ['bug'],
      criteria: { triage: 'needs a maintainer to look at it' },
    });
    expect(plan.planned.map((entry) => entry.label)).toEqual(['bug', 'triage']);
  });

  it('still refuses a label that is both excluded and given criteria', () => {
    const plan = buildPlan({
      repoLabels,
      subject: subject(),
      excludes: ['duplicate'],
      criteria: { duplicate: 'is a repeat of an older issue' },
    });
    expect(plan.planned.map((entry) => entry.label)).not.toContain('duplicate');
  });
});

describe('buildState', () => {
  it('sends the title and body as separate fields', () => {
    expect(buildState(subject(), 100)).toEqual({
      kind: 'issue',
      title: 'The CLI crashes on a brace glob',
      body: 'Steps to reproduce follow.',
    });
  });

  it('truncates an over-long body', () => {
    const state = buildState(subject({ body: 'x'.repeat(50) }), 10) as { body: string };
    expect(state.body).toBe(`${'x'.repeat(10)}\n\n[truncated]`);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('leaves text of exactly the limit alone', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('marks truncated text without using a digit', () => {
    expect(truncate('abcdef', 3)).toBe('abc\n\n[truncated]');
  });
});

describe('decide', () => {
  const plan = buildPlan({ repoLabels, subject: subject() });

  it('applies labels at or above the threshold', () => {
    const decision = decide({
      plan,
      answers: {
        l0: { type: 'noul', noul: 0.94 },
        l1: { type: 'noul', noul: 0.8 },
        l2: { type: 'noul', noul: 0.12 },
      },
      threshold: 0.8,
      subject: subject(),
    });

    expect(decision.applied).toEqual(['bug', 'enhancement']);
    expect(decision.probabilities).toEqual({ bug: 0.94, enhancement: 0.8, duplicate: 0.12 });
  });

  it('maps generated ids back to label names', () => {
    const decision = decide({
      plan,
      answers: { l1: { type: 'noul', noul: 0.99 } },
      threshold: 0.8,
      subject: subject(),
    });
    expect(decision.applied).toEqual(['enhancement']);
  });

  it('reports a missing answer rather than guessing', () => {
    const decision = decide({ plan, answers: {}, threshold: 0.8, subject: subject() });
    expect(decision.applied).toEqual([]);
    expect(decision.rows.filter((row) => row.status === 'no-answer')).toHaveLength(3);
  });

  it('applies the fallback only when nothing passed', () => {
    const nothing = decide({
      plan,
      answers: { l0: { type: 'noul', noul: 0.1 } },
      threshold: 0.8,
      fallbackLabel: 'triage',
      subject: subject(),
    });
    expect(nothing.applied).toEqual(['triage']);

    const something = decide({
      plan,
      answers: { l0: { type: 'noul', noul: 0.9 } },
      threshold: 0.8,
      fallbackLabel: 'triage',
      subject: subject(),
    });
    expect(something.applied).toEqual(['bug']);
  });

  it('does not re-apply a fallback the issue already carries', () => {
    const withTriage = subject({ labels: ['triage'] });
    const decision = decide({
      plan: buildPlan({ repoLabels, subject: withTriage }),
      answers: {},
      threshold: 0.8,
      fallbackLabel: 'triage',
      subject: withTriage,
    });
    expect(decision.applied).toEqual([]);
  });

  it('gives every considered label a row', () => {
    const decision = decide({
      plan,
      answers: { l0: { type: 'noul', noul: 0.9 }, l1: { type: 'noul', noul: 0.1 }, l2: { type: 'noul', noul: 0.1 } },
      threshold: 0.8,
      subject: subject(),
    });
    expect(decision.rows.map((row) => row.label).sort()).toEqual(['bug', 'duplicate', 'enhancement', 'triage']);
  });
});
