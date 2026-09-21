/**
 * Minimal Jev client.
 *
 * Jev is TypeSafe's "System One" model: you hand it a `state` and a map of typed
 * questions, and it hands back one typed answer per question — a probability, a
 * picked option, or a position on a rubric. There is no generated text anywhere
 * in the loop, which is the property this action is built on.
 *
 * The types here are a copy of the ones used in the author's `ai-lab` sandbox.
 * They are copied on purpose: an action that ships a committed bundle should not
 * take a dependency on a private playground repo.
 */

/** What gets evaluated: text, or any structured thing that stands in for it. */
export type State = string | Record<string, unknown> | unknown[];

/** Instructions may be a plain string or a structured object whose fields the question refers to. */
export type Instructions = string | Record<string, unknown> | unknown[];

export type Question =
  | { type: 'noul'; instructions: Instructions; criteria?: { true?: string; false?: string } }
  /** `criteria` maps each option to a rubric line, or null when the name says it. */
  | { type: 'choice'; instructions: Instructions; criteria: Record<string, string | null> }
  /** `criteria` is the ordered levels, lowest first. At least two. */
  | { type: 'score'; instructions: Instructions; criteria: string[] };

export type NoulQuestion = Extract<Question, { type: 'noul' }>;

export interface NoulAnswer {
  type: 'noul';
  /** 0 is no, 1 is yes. A value near the middle means "uncertain", not "medium". */
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted, so it lands between levels. */
  score: number;
  /** Level index (as a string) to the description it came from. */
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  /** The name the alias resolved to, which is not necessarily what was asked for. */
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AskResult extends JevResponse {
  /** Wall clock, measured here. */
  ms: number;
}

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** The version `jev-latest` resolved to when this action was last tuned. See README. */
export const DEFAULT_MODEL = 'jev-1.13.0';

export interface AskOptions {
  apiKey: string;
  model: string;
  state: State;
  questions: Record<string, Question>;
  endpoint?: string;
  /** Total attempts, including the first. Retries only happen for 429 and 529. */
  maxAttempts?: number;
  /** First backoff step in milliseconds; doubles each retry. */
  baseDelayMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so the retry path does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** Thrown for every non-OK response, so callers can branch on `status` if they want to. */
export class JevError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

const RETRYABLE = new Set([429, 529]);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask one state a set of questions.
 *
 * Jev reads the state once and answers every question against it in parallel, so
 * one request with a hundred questions is both cheaper and faster than a hundred
 * requests. This client therefore never splits a batch.
 */
export async function ask(options: AskOptions): Promise<AskResult> {
  const {
    apiKey,
    model,
    state,
    questions,
    endpoint = DEFAULT_ENDPOINT,
    maxAttempts = 4,
    baseDelayMs = 1000,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    signal,
  } = options;

  const started = Date.now();
  let lastError: JevError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ state, model, questions }),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // A transport failure is as transient as a 529, so it shares the retry path.
      lastError = new JevError(`Could not reach the TypeSafe API: ${(error as Error).message}`);
      if (attempt === maxAttempts) throw lastError;
      await sleepImpl(backoffMs(baseDelayMs, attempt));
      continue;
    }

    if (response.ok) {
      const body = (await response.json()) as JevResponse;
      return { ...body, ms: Date.now() - started };
    }

    const detail = await response.text().catch(() => '');
    const error = new JevError(describe(response.status, detail), response.status);
    if (!RETRYABLE.has(response.status) || attempt === maxAttempts) throw error;

    lastError = error;
    await sleepImpl(retryAfterMs(response) ?? backoffMs(baseDelayMs, attempt));
  }

  /* c8 ignore next */
  throw lastError ?? new JevError('The TypeSafe API could not be reached.');
}

function backoffMs(base: number, attempt: number): number {
  // Exponential, with a little jitter so several jobs firing at once do not line up.
  return Math.round(base * 2 ** (attempt - 1) * (1 + Math.random() * 0.25));
}

/** The API sets `retry-after` on some rate-limit responses; honour it when it is there. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers?.get?.('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function describe(status: number, detail: string): string {
  const trimmed = detail.trim().slice(0, 300);
  const suffix = trimmed ? `: ${trimmed}` : '';
  switch (status) {
    case 401:
    case 403:
      return `TypeSafe rejected the API key (${status}). Check that the \`api-key\` input is set to a valid key, usually from a repository secret${suffix}`;
    case 422:
      return `TypeSafe rejected the questions (422). This is a bug in the action unless a label description is extremely long${suffix}`;
    case 429:
      return `TypeSafe rate limit reached (429)${suffix}`;
    case 529:
      return `TypeSafe is temporarily overloaded (529)${suffix}`;
    default:
      return `TypeSafe returned an error (${status})${suffix}`;
  }
}
