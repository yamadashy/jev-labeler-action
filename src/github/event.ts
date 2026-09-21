import type { context } from '@actions/github';
import type { LabelSubject } from '../core/types.js';

/**
 * The runner-provided event context.
 *
 * Derived from the exported value rather than imported from `lib/context`, which
 * the package's `exports` map does not expose.
 */
export type ActionContext = typeof context;

/**
 * Reading the subject out of the event payload.
 *
 * The issue title and body are read here, from the payload the runner already
 * wrote to disk, and never through a shell. That is the difference between text
 * an attacker controls being *data* and it being *code*: see the security
 * section of the README.
 */

export const SUPPORTED_EVENT = 'issues';
export const SUPPORTED_ACTIONS = ['opened', 'edited', 'reopened'];

export class UnsupportedEventError extends Error {}

export function subjectFromContext(context: ActionContext): LabelSubject {
  if (context.eventName !== SUPPORTED_EVENT) {
    throw new UnsupportedEventError(
      `This action only handles \`${SUPPORTED_EVENT}\` events, but the workflow was triggered by \`${context.eventName}\`. ` +
        `Trigger it with \`on: issues\` (types: ${SUPPORTED_ACTIONS.join(', ')}).`,
    );
  }

  const issue = context.payload.issue;
  if (!issue) {
    throw new UnsupportedEventError('The `issues` event payload did not contain an issue.');
  }

  // `pull_request` on an issue payload means the issue is really a PR. Pull
  // requests are out of scope for now; the core would handle them unchanged.
  if (issue.pull_request) {
    throw new UnsupportedEventError('This action does not label pull requests yet.');
  }

  const user = issue.user as { login?: string; type?: string } | undefined;
  const login = typeof user?.login === 'string' ? user.login : '';

  return {
    kind: 'issue',
    number: issue.number as number,
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    author: { login, isBot: isBotLogin(login, user?.type) },
    labels: Array.isArray(issue.labels)
      ? issue.labels
          .map((label: unknown) => (typeof label === 'string' ? label : (label as { name?: string })?.name))
          .filter((name: unknown): name is string => typeof name === 'string')
      : [],
  };
}

/**
 * GitHub reports apps as `type: "Bot"`, and their logins end in `[bot]`. Both are
 * checked because the payload for an installation-authored issue is not always
 * as tidy as the REST response.
 */
export function isBotLogin(login: string, type?: string): boolean {
  return type === 'Bot' || /\[bot\]$/i.test(login);
}
