import { describe, expect, it, vi } from 'vitest';
import { ask, JevError } from '../../src/jev/client.js';

const ok = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: () => null },
  }) as unknown as Response;

const fail = (status: number, detail = '', retryAfter?: string, contentType?: string): Response =>
  ({
    ok: false,
    status,
    text: async () => detail,
    headers: {
      get: (name: string) =>
        name === 'retry-after' ? (retryAfter ?? null) : name === 'content-type' ? (contentType ?? null) : null,
    },
  }) as unknown as Response;

const answer = {
  model: 'jev-1.13.0',
  answers: { l0: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 1, output_tokens: 1 },
};

const base = {
  apiKey: 'key',
  model: 'jev-1.13.0',
  state: 'hello',
  questions: { l0: { type: 'noul' as const, instructions: 'is this a greeting' } },
};

describe('ask', () => {
  it('sends the key as a bearer token and the documented body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(answer));
    await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key');
    expect(JSON.parse(init.body as string)).toEqual({
      state: 'hello',
      model: 'jev-1.13.0',
      questions: base.questions,
    });
  });

  it('returns the answers with a measured latency', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(answer));
    const result = await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.model).toBe('jev-1.13.0');
    expect(result.answers.l0).toEqual({ type: 'noul', noul: 0.9 });
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('retries a rate limit and then succeeds', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok(answer));

    const result = await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(result.answers.l0).toBeDefined();
  });

  it('retries an overloaded response', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValueOnce(fail(529)).mockResolvedValueOnce(ok(answer));
    await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honours a retry-after header', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fail(429, '', '3'))
      .mockResolvedValueOnce(ok(answer));
    await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl });
    expect(sleepImpl).toHaveBeenCalledWith(3000);
  });

  it('backs off exponentially and gives up after the attempt budget', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(fail(429));

    await expect(
      ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl, maxAttempts: 3, baseDelayMs: 100 }),
    ).rejects.toThrow(/rate limit/);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const delays = sleepImpl.mock.calls.map(([ms]) => ms as number);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
  });

  it('does not retry a bad key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(403, 'authentication_error'));
    await expect(ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(
      /rejected the API key/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps a JSON 403 as a bad key', async () => {
    const detail = '{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server"}}';
    const fetchImpl = vi.fn().mockResolvedValue(fail(403, detail, undefined, 'application/json'));
    const error = await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).message).toMatch(/rejected the API key/);
    expect((error as JevError).kind).toBeUndefined();
  });

  it('tells an HTML 403 from the firewall apart from a bad key, and does not retry it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(fail(403, '<!DOCTYPE html><html><body>Forbidden</body></html>', undefined, 'text/html'));
    const error = await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).kind).toBe('firewall');
    expect((error as JevError).status).toBe(403);
    expect((error as JevError).message).toMatch(/web application firewall/);
    expect((error as JevError).message).not.toMatch(/API key/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('recognises the firewall page by its body when the content type is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(403, '\n<!DOCTYPE html>'));
    const error = await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e);
    expect((error as JevError).kind).toBe('firewall');
  });

  it('does not retry malformed questions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(422, 'questions.l0: bad'));
    const error = await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).status).toBe(422);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a transport failure', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce(ok(answer));
    const result = await ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl });
    expect(result.answers.l0).toBeDefined();
  });

  it('does not retry an abort', async () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    const fetchImpl = vi.fn().mockRejectedValue(aborted);
    await expect(ask({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow('aborted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
