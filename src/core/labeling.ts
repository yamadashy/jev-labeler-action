import type { Answer, NoulQuestion, State } from '../jev/client.js';
import { canonical } from './inputs.js';
import type { ChangedFile, LabelSubject, RepoLabel, ResultRow, SubjectKind } from './types.js';

/**
 * The labelling core.
 *
 * Everything in this file is pure: labels and an issue go in, a set of Jev
 * questions comes out, and answers plus a threshold turn into a decision. No
 * network, no `@actions/*`, no process state — which is what makes the rules
 * below testable without a GitHub event.
 */

/** How each kind of subject is named to Jev. */
const SUBJECT_NOUN: Record<SubjectKind, string> = {
  issue: 'GitHub issue',
  pull_request: 'GitHub pull request',
};

/**
 * The zero-config question wording.
 *
 * The issue sentence is the one measured in the backtest over Repomix's issue
 * history, so the accuracy and threshold advice in the README describes what the
 * action actually sends. Reword it and those numbers stop being true. The pull
 * request sentence differs only in the noun, and was measured the same way.
 *
 * Deliberately free of digits: digits inside `instructions` measurably pull Jev's
 * probabilities around, and this question has no reason to contain any.
 */
export function zeroConfigInstructions(label: string, description: string, kind: SubjectKind = 'issue'): string {
  return `A maintainer triaging this ${SUBJECT_NOUN[kind]} would put the label "${label}" on it. The repository describes that label as: "${description}".`;
}

export interface PlanOptions {
  /** Every label defined on the repository, in any order. */
  repoLabels: RepoLabel[];
  /** When non-empty, only these labels are considered. */
  allowlist?: string[];
  /** Labels the user never wants applied. Wins over everything else. */
  excludes?: string[];
  /** Label name to plain-language condition; overrides the GitHub description. */
  criteria?: Record<string, string>;
  subject: LabelSubject;
}

export interface PlannedLabel {
  id: string;
  label: string;
  condition: string;
}

export interface EvaluationPlan {
  questions: Record<string, NoulQuestion>;
  /** Question id to label name. Ids are generated, because label names are arbitrary text. */
  idToLabel: Record<string, string>;
  planned: PlannedLabel[];
  /** Labels that were never sent to Jev, with the reason. Shown in the job summary. */
  skipped: ResultRow[];
}

/**
 * Decide which labels to ask about, and build one independent question each.
 *
 * Labels already on the issue are not asked about at all. The action only ever
 * adds labels, so an answer for one could not change anything, and leaving it
 * out keeps the request smaller.
 */
export function buildPlan(options: PlanOptions): EvaluationPlan {
  const { repoLabels, subject } = options;
  const criteria = options.criteria ?? {};
  const allowlist = new Set((options.allowlist ?? []).map(canonical));
  const excludes = new Set((options.excludes ?? []).map(canonical));
  const present = new Set(subject.labels.map(canonical));

  // Criteria are keyed by whatever the user typed; index them case-insensitively.
  const criteriaByCanonical = new Map(
    Object.entries(criteria).map(([label, condition]) => [canonical(label), condition]),
  );

  const questions: Record<string, NoulQuestion> = {};
  const idToLabel: Record<string, string> = {};
  const planned: PlannedLabel[] = [];
  const skipped: ResultRow[] = [];

  let index = 0;
  for (const repoLabel of repoLabels) {
    const key = canonical(repoLabel.name);
    const override = criteriaByCanonical.get(key);

    if (present.has(key)) {
      skipped.push({ label: repoLabel.name, probability: null, status: 'already-present' });
      continue;
    }
    if (excludes.has(key)) {
      skipped.push({ label: repoLabel.name, probability: null, status: 'excluded' });
      continue;
    }
    // An explicit `criteria` entry opts a label in even when the allowlist is set,
    // because writing a condition for a label is a clearer statement of intent
    // than omitting it from a list.
    if (allowlist.size > 0 && !allowlist.has(key) && override === undefined) {
      skipped.push({ label: repoLabel.name, probability: null, status: 'not-allowlisted' });
      continue;
    }

    const condition = override ?? repoLabel.description?.trim();
    if (!condition) {
      skipped.push({ label: repoLabel.name, probability: null, status: 'no-condition' });
      continue;
    }

    const id = `l${index++}`;
    // A hand-written condition is sent as the whole question, the way the
    // backtest's hand-written variant was written: it already says what the
    // label means, and wrapping it in boilerplate only dilutes it.
    questions[id] = {
      type: 'noul',
      instructions: override ? override : zeroConfigInstructions(repoLabel.name, condition, subject.kind),
    };
    idToLabel[id] = repoLabel.name;
    planned.push({ id, label: repoLabel.name, condition });
  }

  return { questions, idToLabel, planned, skipped };
}

/** How many changed files a pull request's state carries before it is cut short. */
export const MAX_FILES = 100;

/**
 * The state handed to Jev.
 *
 * An object rather than one concatenated string, so the title cannot be mistaken
 * for the first line of the body. A pull request adds its changed-file list; an
 * issue's state is unchanged from the backtested shape, down to the field order.
 */
export function buildState(subject: LabelSubject, maxBodyChars: number): State {
  const state: Record<string, unknown> = {
    kind: subject.kind,
    title: subject.title,
    body: truncate(subject.body, maxBodyChars),
  };
  if (subject.kind === 'pull_request') {
    state.files = buildFileState(subject.files ?? []);
  }
  return state;
}

/**
 * The changed-file list as Jev sees it.
 *
 * Capped, because a pull request touching a thousand generated files would bury
 * the handful that say what it is. The marker entry is digit-free like every
 * other piece of text the action writes.
 */
export function buildFileState(files: ChangedFile[], maxFiles: number = MAX_FILES): ChangedFile[] {
  const shown = files.slice(0, maxFiles);
  if (files.length > maxFiles) shown.push({ path: '[truncated]', status: 'more files not shown' });
  return shown;
}

/**
 * Attach patches to a changed-file list within one budget for the whole pull
 * request, spent in the order the files came back.
 *
 * A per-file budget would let a wide pull request multiply it out; one budget is
 * the number a user can reason about.
 */
export function withPatches(files: (ChangedFile & { patch?: string })[], maxDiffChars: number): ChangedFile[] {
  if (maxDiffChars <= 0) return files.map(({ path, status }) => ({ path, status }));

  let remaining = maxDiffChars;
  return files.map(({ path, status, patch }) => {
    if (!patch || remaining <= 0) return { path, status };
    const slice = truncate(patch, remaining);
    remaining -= Math.min(patch.length, remaining);
    return { path, status, patch: slice };
  });
}

/** Cut an over-long text at the limit. The marker is digit-free on purpose. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

export interface DecideOptions {
  plan: EvaluationPlan;
  answers: Record<string, Answer>;
  threshold: number;
  fallbackLabel?: string;
  subject: LabelSubject;
}

export interface Decision {
  /** Labels to add, in the order the repository lists them. */
  applied: string[];
  /** Every label that was actually evaluated, by name. */
  probabilities: Record<string, number>;
  /** Every considered label, evaluated or not, for the job summary. */
  rows: ResultRow[];
}

/**
 * Turn answers into a decision.
 *
 * A label passes when its probability is at or above the threshold. Nothing is
 * ever removed, so this only ever produces a list of additions.
 */
export function decide(options: DecideOptions): Decision {
  const { plan, answers, threshold, subject } = options;
  const present = new Set(subject.labels.map(canonical));

  const applied: string[] = [];
  const probabilities: Record<string, number> = {};
  const rows: ResultRow[] = [];

  for (const { id, label } of plan.planned) {
    const answer = answers[id];
    if (answer?.type !== 'noul') {
      rows.push({ label, probability: null, status: 'no-answer' });
      continue;
    }
    probabilities[label] = answer.noul;
    const passes = answer.noul >= threshold;
    if (passes) applied.push(label);
    rows.push({ label, probability: answer.noul, status: passes ? 'applied' : 'below-threshold' });
  }

  const allRows = [...rows, ...plan.skipped];

  const fallback = options.fallbackLabel?.trim();
  if (fallback && applied.length === 0 && !present.has(canonical(fallback))) {
    applied.push(fallback);
    // The fallback need not be one of the evaluated labels — it may have been
    // excluded, or have no description — so it gets its own row when absent.
    const existing = allRows.find((row) => canonical(row.label) === canonical(fallback));
    if (existing) {
      existing.status = 'applied-as-fallback';
    } else {
      allRows.push({ label: fallback, probability: null, status: 'applied-as-fallback' });
    }
  }

  return { applied, probabilities, rows: allRows };
}
