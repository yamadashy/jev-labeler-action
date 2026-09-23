import { describe, expect, it, vi } from 'vitest';
import { labelSubject } from '../../src/core/run.js';
import type { LabelSubject, RepoLabel } from '../../src/core/types.js';
import { FIREWALL_MESSAGE, JevError } from '../../src/jev/client.js';

const repoLabels: RepoLabel[] = [
  { name: 'bug', description: "Something isn't working" },
  { name: 'question', description: 'Further information is requested' },
  { name: 'triage', description: null },
];

const subject: LabelSubject = {
  kind: 'issue',
  number: 12,
  title: 'How do I exclude a directory?',
  body: 'I cannot work out the flag.',
  labels: [],
  author: { login: 'octocat', isBot: false },
};

const config = { apiKey: 'key', model: 'jev-1.13.0', threshold: 0.8, maxBodyChars: 6000 };

describe('labelSubject', () => {
  it('asks once for every candidate label and applies what passes', async () => {
    const askFn = vi.fn().mockResolvedValue({
      model: 'jev-1.13.0',
      answers: { l0: { type: 'noul', noul: 0.05 }, l1: { type: 'noul', noul: 0.93 }, l2: { type: 'noul', noul: 0.1 } },
      usage: { input_tokens: 300, output_tokens: 40 },
      ms: 400,
    });

    const result = await labelSubject(subject, repoLabels, config, askFn);

    expect(askFn).toHaveBeenCalledTimes(1);
    expect(Object.keys(askFn.mock.calls[0][0].questions)).toHaveLength(3);
    expect(result.applied).toEqual(['question']);
    expect(result.evaluatedCount).toBe(3);
    expect(result.model).toBe('jev-1.13.0');
  });

  it('spends no request when nothing is left to ask about', async () => {
    const askFn = vi.fn();
    const result = await labelSubject(
      subject,
      [{ name: 'triage', description: null }],
      { ...config, excludes: ['triage'] },
      askFn,
    );

    expect(askFn).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(result.rows).toEqual([{ label: 'triage', probability: null, status: 'excluded' }]);
  });

  it('still applies a fallback when there was nothing to ask', async () => {
    const askFn = vi.fn();
    const result = await labelSubject(
      subject,
      [{ name: 'triage', description: null }],
      { ...config, excludes: ['triage'], fallbackLabel: 'triage' },
      askFn,
    );
    expect(result.applied).toEqual(['triage']);
  });

  it('leaves a bot-authored issue alone by default', async () => {
    const askFn = vi.fn();
    const botIssue = { ...subject, author: { login: 'renovate[bot]', isBot: true } };

    const result = await labelSubject(botIssue, repoLabels, config, askFn);

    expect(askFn).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.skippedReason).toBe('bot-author');
  });

  it('does not let a fallback sneak onto a bot-authored issue', async () => {
    const botIssue = { ...subject, author: { login: 'renovate[bot]', isBot: true } };
    const result = await labelSubject(botIssue, repoLabels, { ...config, fallbackLabel: 'triage' }, vi.fn());
    expect(result.applied).toEqual([]);
  });

  it('labels a bot-authored issue when skip-bots is turned off', async () => {
    const askFn = vi.fn().mockResolvedValue({
      model: 'jev-1.13.0',
      answers: { l0: { type: 'noul', noul: 0.91 }, l1: { type: 'noul', noul: 0.02 } },
      usage: { input_tokens: 300, output_tokens: 40 },
      ms: 220,
    });
    const botIssue = { ...subject, author: { login: 'renovate[bot]', isBot: true } };

    const result = await labelSubject(botIssue, repoLabels, { ...config, skipBots: false }, askFn);

    expect(askFn).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual(['bug']);
    expect(result.skippedReason).toBeUndefined();
  });

  it('lets a Jev failure propagate so the step fails without touching the issue', async () => {
    const askFn = vi.fn().mockRejectedValue(new Error('TypeSafe rate limit reached (429)'));
    await expect(labelSubject(subject, repoLabels, config, askFn)).rejects.toThrow(/429/);
  });

  it('skips, rather than fails, when the firewall refuses the text, and applies no fallback', async () => {
    const askFn = vi.fn().mockRejectedValue(new JevError(FIREWALL_MESSAGE, 403, 'firewall'));
    const result = await labelSubject(subject, repoLabels, { ...config, fallbackLabel: 'triage' }, askFn);

    expect(askFn).toHaveBeenCalledTimes(1);
    expect(result.skippedReason).toBe('firewall');
    expect(result.applied).toEqual([]);
    expect(result.probabilities).toEqual({});
    expect(result.model).toBe('jev-1.13.0');
  });

  it('still fails on a bad key', async () => {
    const askFn = vi.fn().mockRejectedValue(new JevError('TypeSafe rejected the API key (403).', 403));
    await expect(labelSubject(subject, repoLabels, config, askFn)).rejects.toThrow(/API key/);
  });
});
