import { describe, expect, it } from 'vitest';
import { type ActionContext, isBotLogin, subjectFromContext, UnsupportedEventError } from '../../src/github/event.js';

const context = (eventName: string, payload: Record<string, unknown>): ActionContext =>
  ({ eventName, payload }) as unknown as ActionContext;

describe('subjectFromContext', () => {
  it('reads the title, body and current labels from the payload', () => {
    const subject = subjectFromContext(
      context('issues', {
        issue: { number: 9, title: 'Crash', body: 'It crashes.', labels: [{ name: 'bug' }, 'triage'] },
      }),
    );

    expect(subject).toEqual({
      kind: 'issue',
      number: 9,
      title: 'Crash',
      body: 'It crashes.',
      labels: ['bug', 'triage'],
      author: { login: '', isBot: false },
    });
  });

  it('marks an app-authored issue as bot-authored', () => {
    const fromType = subjectFromContext(
      context('issues', {
        issue: { number: 9, title: 'x', body: '', labels: [], user: { login: 'renovate', type: 'Bot' } },
      }),
    );
    expect(fromType.author).toEqual({ login: 'renovate', isBot: true });

    const fromLogin = subjectFromContext(
      context('issues', { issue: { number: 9, title: 'x', body: '', labels: [], user: { login: 'renovate[bot]' } } }),
    );
    expect(fromLogin.author.isBot).toBe(true);
  });

  it('does not mistake a human for a bot', () => {
    const subject = subjectFromContext(
      context('issues', {
        issue: { number: 9, title: 'x', body: '', labels: [], user: { login: 'robot-lover', type: 'User' } },
      }),
    );
    expect(subject.author).toEqual({ login: 'robot-lover', isBot: false });
  });

  it('treats a missing body as empty rather than failing', () => {
    const subject = subjectFromContext(
      context('issues', { issue: { number: 9, title: 'Crash', body: null, labels: [] } }),
    );
    expect(subject.body).toBe('');
  });

  it('refuses an event it does not handle', () => {
    expect(() => subjectFromContext(context('push', {}))).toThrow(UnsupportedEventError);
    expect(() => subjectFromContext(context('push', {}))).toThrow(/triggered by `push`/);
  });

  it('refuses a pull request arriving through the issues payload', () => {
    expect(() =>
      subjectFromContext(
        context('issues', { issue: { number: 9, title: 'PR', body: '', labels: [], pull_request: {} } }),
      ),
    ).toThrow(/pull_request_target/);
  });

  it('refuses an issues event with no issue', () => {
    expect(() => subjectFromContext(context('issues', {}))).toThrow(/did not contain an issue/);
  });

  for (const eventName of ['pull_request', 'pull_request_target']) {
    it(`reads a pull request from a ${eventName} payload`, () => {
      const subject = subjectFromContext(
        context(eventName, {
          pull_request: {
            number: 42,
            title: 'Add a flag',
            body: 'It adds a flag.',
            labels: [{ name: 'enhancement' }],
            user: { login: 'octocat', type: 'User' },
          },
        }),
      );

      expect(subject).toEqual({
        kind: 'pull_request',
        number: 42,
        title: 'Add a flag',
        body: 'It adds a flag.',
        labels: ['enhancement'],
        author: { login: 'octocat', isBot: false },
      });
    });

    it(`refuses a ${eventName} event with no pull request`, () => {
      expect(() => subjectFromContext(context(eventName, {}))).toThrow(/did not contain a pull request/);
    });
  }

  it('marks an app-authored pull request as bot-authored', () => {
    const subject = subjectFromContext(
      context('pull_request_target', {
        pull_request: {
          number: 7,
          title: 'chore(deps): bump x',
          body: '',
          labels: [],
          user: { login: 'renovate[bot]' },
        },
      }),
    );
    expect(subject.author.isBot).toBe(true);
  });
});

describe('isBotLogin', () => {
  it('recognises the bot suffix regardless of case', () => {
    expect(isBotLogin('dependabot[BOT]')).toBe(true);
  });

  it('leaves an ordinary login alone', () => {
    expect(isBotLogin('yamadashy')).toBe(false);
    expect(isBotLogin('botanist')).toBe(false);
  });
});
