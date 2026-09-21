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

  it('refuses an event that is not an issue event', () => {
    expect(() => subjectFromContext(context('push', {}))).toThrow(UnsupportedEventError);
    expect(() => subjectFromContext(context('push', {}))).toThrow(/only handles `issues` events/);
  });

  it('refuses a pull request arriving through the issues payload', () => {
    expect(() =>
      subjectFromContext(
        context('issues', { issue: { number: 9, title: 'PR', body: '', labels: [], pull_request: {} } }),
      ),
    ).toThrow(/pull requests/);
  });

  it('refuses an issues event with no issue', () => {
    expect(() => subjectFromContext(context('issues', {}))).toThrow(/did not contain an issue/);
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
