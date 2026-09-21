import { type AskResult, ask } from '../jev/client.js';
import { buildPlan, buildState, type Decision, decide } from './labeling.js';
import type { LabelSubject, RepoLabel } from './types.js';

/**
 * The whole decision, end to end, with the network call injected.
 *
 * This is the piece both the action and the smoke script run, so what you see in
 * a local smoke test is what a workflow will do.
 */

export interface LabelRunConfig {
  apiKey: string;
  model: string;
  threshold: number;
  maxBodyChars: number;
  allowlist?: string[];
  excludes?: string[];
  criteria?: Record<string, string>;
  fallbackLabel?: string;
  endpoint?: string;
  /** Leave issues opened by an app alone. See `skippedReason` below. */
  skipBots?: boolean;
}

export interface LabelRunResult extends Decision {
  /** The version the model alias resolved to. */
  model: string;
  ms: number;
  usage: AskResult['usage'];
  /** How many labels were actually sent to Jev. */
  evaluatedCount: number;
  /** Set when the run stopped before asking anything, so the summary can say why. */
  skippedReason?: 'bot-author';
}

export type AskFn = typeof ask;

export async function labelSubject(
  subject: LabelSubject,
  repoLabels: RepoLabel[],
  config: LabelRunConfig,
  askFn: AskFn = ask,
): Promise<LabelRunResult> {
  // Issues opened by an app are template text, not a report: a Renovate
  // configuration warning reads like a bug report to any reader, model or human.
  // This was the only genuine false positive found in the backtest, so it is off
  // by default rather than left to the threshold.
  if (config.skipBots !== false && subject.author.isBot) {
    return {
      applied: [],
      probabilities: {},
      rows: [],
      model: config.model,
      ms: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      evaluatedCount: 0,
      skippedReason: 'bot-author',
    };
  }

  const plan = buildPlan({
    repoLabels,
    subject,
    allowlist: config.allowlist,
    excludes: config.excludes,
    criteria: config.criteria,
  });

  // Nothing to ask about: report the skips rather than spending a request.
  if (plan.planned.length === 0) {
    const decision = decide({
      plan,
      answers: {},
      threshold: config.threshold,
      fallbackLabel: config.fallbackLabel,
      subject,
    });
    return {
      ...decision,
      model: config.model,
      ms: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      evaluatedCount: 0,
    };
  }

  const response = await askFn({
    apiKey: config.apiKey,
    model: config.model,
    state: buildState(subject, config.maxBodyChars),
    questions: plan.questions,
    endpoint: config.endpoint,
  });

  const decision = decide({
    plan,
    answers: response.answers,
    threshold: config.threshold,
    fallbackLabel: config.fallbackLabel,
    subject,
  });

  return {
    ...decision,
    model: response.model,
    ms: response.ms,
    usage: response.usage,
    evaluatedCount: plan.planned.length,
  };
}
