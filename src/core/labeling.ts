import type { Answer, NoulQuestion, State } from '../jev/client.js';
import { canonical } from './inputs.js';
import type { LabelSubject, RepoLabel, ResultRow } from './types.js';

/**
 * The labelling core.
 *
 * Everything in this file is pure: labels and an issue go in, a set of Jev
 * questions comes out, and answers plus a threshold turn into a decision. No
 * network, no `@actions/*`, no process state — which is what makes the rules
 * below testable without a GitHub event.
 */

/**
 * The zero-config question wording.
 *
 * This exact sentence is the one measured in the backtest over Repomix's issue
 * history, so the accuracy and threshold advice in the README describes what the
 * action actually sends. Reword it and those numbers stop being true.
 *
 * Deliberately free of digits: digits inside `instructions` measurably pull Jev's
 * probabilities around, and this question has no reason to contain any.
 */
export function zeroConfigInstructions(label: string, description: string): string {
  return `A maintainer triaging this GitHub issue would put the label "${label}" on it. The repository describes that label as: "${description}".`;
}

export interface PlanOptions {
  /** Every label defined on the repository, in any order. */
  repoLabels: RepoLabel[];
  /** When non-empty, only these labels are considered. */
  allowlist?: string[];
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
      instructions: override ? override : zeroConfigInstructions(repoLabel.name, condition),
    };
    idToLabel[id] = repoLabel.name;
    planned.push({ id, label: repoLabel.name, condition });
  }

  return { questions, idToLabel, planned, skipped };
}

/**
 * The state handed to Jev.
 *
 * An object rather than one concatenated string, so the title cannot be mistaken
 * for the first line of the body, and so a pull request can add fields later.
 */
export function buildState(subject: LabelSubject, maxBodyChars: number): State {
  return {
    kind: subject.kind,
    title: subject.title,
    body: truncate(subject.body, maxBodyChars),
  };
}

/** Cut an over-long body at the limit. The marker is digit-free on purpose. */
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
