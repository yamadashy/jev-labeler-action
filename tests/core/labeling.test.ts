import { describe, expect, it } from 'vitest';
import {
  buildFileState,
  buildPlan,
  buildState,
  decide,
  truncate,
  withPatches,
  zeroConfigInstructions,
} from '../../src/core/labeling.js';
import type { ChangedFile, LabelSubject, RepoLabel } from '../../src/core/types.js';

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

  it('never considers a label the user excluded, even when it is named elsewhere', () => {
    const plan = buildPlan({
      repoLabels,
      subject: subject(),
      excludes: ['duplicate'],
      allowlist: ['duplicate'],
      criteria: { duplicate: 'The author says this was already reported.' },
    });
    expect(plan.planned.map((p) => p.label)).not.toContain('duplicate');
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

describe('pull request state', () => {
  const pull = (files: ChangedFile[] = []): LabelSubject => subject({ kind: 'pull_request', files });

  it('carries the changed-file list alongside the title and body', () => {
    const state = buildState(pull([{ path: 'src/cli.ts', status: 'modified' }]), 100);
    expect(state).toEqual({
      kind: 'pull_request',
      title: 'The CLI crashes on a brace glob',
      body: 'Steps to reproduce follow.',
      files: [{ path: 'src/cli.ts', status: 'modified' }],
    });
  });

  it('leaves an issue state byte-identical to the backtested shape', () => {
    // The issue numbers in the README were measured against exactly this state.
    expect(JSON.stringify(buildState(subject(), 6000))).toBe(
      '{"kind":"issue","title":"The CLI crashes on a brace glob","body":"Steps to reproduce follow."}',
    );
  });

  it('never gives an issue a files field, even if one is set', () => {
    expect(buildState(subject({ files: [{ path: 'x', status: 'added' }] }), 100)).not.toHaveProperty('files');
  });

  it('says "pull request" in the zero-config wording, and nothing else changes', () => {
    expect(zeroConfigInstructions('bug', 'broken', 'pull_request')).toBe(
      zeroConfigInstructions('bug', 'broken', 'issue').replace('GitHub issue', 'GitHub pull request'),
    );
  });

  it('keeps the issue wording as the default, so old call sites cannot drift', () => {
    expect(zeroConfigInstructions('bug', 'broken')).toContain('this GitHub issue would');
  });

  it('builds pull request questions with the pull request noun', () => {
    const plan = buildPlan({ repoLabels: [repoLabels[0]], subject: pull() });
    expect(plan.questions.l0.instructions).toContain('GitHub pull request');
  });
});

describe('buildFileState', () => {
  const files = (count: number): ChangedFile[] =>
    Array.from({ length: count }, (_, index) => ({ path: `src/f${index}.ts`, status: 'modified' }));

  it('passes a short list through untouched', () => {
    expect(buildFileState(files(3), 10)).toEqual(files(3));
  });

  it('cuts a long list short and says so without a digit', () => {
    const state = buildFileState(files(5), 3);
    expect(state).toHaveLength(4);
    expect(state.slice(0, 3)).toEqual(files(3));
    expect(state[3]).toEqual({ path: '[truncated]', status: 'more files not shown' });
    expect(JSON.stringify(state[3])).not.toMatch(/\d/);
  });

  it('does not mark a list that exactly fills the cap', () => {
    expect(buildFileState(files(3), 3)).toEqual(files(3));
  });
});

describe('withPatches', () => {
  const files = [
    { path: 'a.ts', status: 'modified', patch: 'aaaa' },
    { path: 'b.ts', status: 'modified', patch: 'bbbb' },
  ];

  it('drops every patch when the budget is zero', () => {
    expect(withPatches(files, 0)).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'modified' },
    ]);
  });

  it('keeps patches that fit', () => {
    expect(withPatches(files, 100)).toEqual(files);
  });

  it('spends one budget across the pull request, in order', () => {
    // Six characters: all of `aaaa`, then two of `bbbb`.
    const result = withPatches(files, 6);
    expect(result[0].patch).toBe('aaaa');
    expect(result[1].patch).toBe('bb\n\n[truncated]');
  });

  it('leaves later files bare once the budget is gone', () => {
    const result = withPatches(files, 4);
    expect(result[0].patch).toBe('aaaa');
    expect(result[1]).toEqual({ path: 'b.ts', status: 'modified' });
  });

  it('copes with a file the API gave no patch for', () => {
    expect(withPatches([{ path: 'logo.png', status: 'added' }], 100)).toEqual([{ path: 'logo.png', status: 'added' }]);
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
