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
 * The title and body are read here, from the payload the runner already wrote to
 * disk, and never through a shell. That is the difference between text an
 * attacker controls being *data* and it being *code*: see the security section
 * of the README. Nothing in this file touches a pull request's branch or code.
 */

export const SUPPORTED_EVENTS = ['issues', 'pull_request', 'pull_request_target'];

export class UnsupportedEventError extends Error {}

export function subjectFromContext(context: ActionContext): LabelSubject {
  if (!SUPPORTED_EVENTS.includes(context.eventName)) {
    throw new UnsupportedEventError(
      `This action handles ${SUPPORTED_EVENTS.map((name) => `\`${name}\``).join(', ')} events, ` +
        `but the workflow was triggered by \`${context.eventName}\`.`,
    );
  }

  if (context.eventName === 'issues') {
    const issue = context.payload.issue;
    if (!issue) {
      throw new UnsupportedEventError('The `issues` event payload did not contain an issue.');
    }
    // An `issues` event never fires for a pull request, but the payloads share a
    // shape, so a mixed-up workflow would otherwise silently label the wrong thing.
    if (issue.pull_request) {
      throw new UnsupportedEventError(
        'This `issues` payload describes a pull request. Trigger pull request labelling with `on: pull_request_target`.',
      );
    }
    return subjectFrom('issue', issue);
  }

  const pull = context.payload.pull_request;
  if (!pull) {
    throw new UnsupportedEventError(`The \`${context.eventName}\` event payload did not contain a pull request.`);
  }
  return subjectFrom('pull_request', pull);
}

type Payload = Record<string, unknown>;

/** Issues and pull requests carry the same fields under the same names here. */
function subjectFrom(kind: LabelSubject['kind'], payload: Payload): LabelSubject {
  const user = payload.user as { login?: string; type?: string } | undefined;
  const login = typeof user?.login === 'string' ? user.login : '';

  return {
    kind,
    number: payload.number as number,
    title: typeof payload.title === 'string' ? payload.title : '',
    body: typeof payload.body === 'string' ? payload.body : '',
    author: { login, isBot: isBotLogin(login, user?.type) },
    labels: Array.isArray(payload.labels)
      ? payload.labels
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
