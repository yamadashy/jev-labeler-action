/**
 * Measures what a pull request's state should contain. Not part of the action.
 *
 * Repomix's pull requests rarely carry human labels, but their titles follow
 * Conventional Commits, which is a maintainer's own statement of what the change
 * is. That is the ground truth here: `feat` means enhancement, `fix` means bug,
 * `docs` means documentation. The prefix is stripped before anything is sent —
 * leaving it in would be handing over the answer.
 *
 *   export TYPESAFE_API_KEY=...
 *   npx tsx scripts/measure-pr.ts --repo yamadashy/repomix --count 150
 *
 * Six variants per pull request: three states (title and body only; plus the
 * changed-file list; plus truncated patches) times two wordings (the label's
 * GitHub description, and hand-written criteria). Prints precision and recall
 * per label for each, with tokens and latency.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { buildState, withPatches, zeroConfigInstructions } from '../src/core/labeling.js';
import type { ChangedFile, LabelSubject } from '../src/core/types.js';
import { isBotLogin } from '../src/github/event.js';
import { ask, DEFAULT_MODEL, type NoulQuestion } from '../src/jev/client.js';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'yamadashy/repomix' },
    count: { type: 'string', default: '150' },
    threshold: { type: 'string', default: '0.8' },
    model: { type: 'string', default: DEFAULT_MODEL },
    cache: { type: 'string', default: '.measure-cache/pulls.json' },
    'max-diff-chars': { type: 'string', default: '4000' },
    // Only pull requests whose body is shorter than this. Zero keeps them all.
    'thin-body': { type: 'string', default: '0' },
  },
});

const repo = values.repo as string;
const threshold = Number(values.threshold);
const maxDiffChars = Number(values['max-diff-chars']);
const model = values.model as string;

function requireApiKey(): string {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    console.error('TYPESAFE_API_KEY is not set.');
    process.exit(2);
  }
  return key;
}

const apiKey = requireApiKey();

/** Conventional Commit type to the Repomix label a maintainer would use. */
const TYPE_TO_LABEL: Record<string, string> = {
  feat: 'enhancement',
  fix: 'bug',
  docs: 'documentation',
};

const LABELS = ['bug', 'enhancement', 'documentation'] as const;
type Label = (typeof LABELS)[number];

/** The label descriptions Repomix actually has in GitHub, for the zero-config wording. */
const DESCRIPTIONS: Record<Label, string> = {
  bug: "Something isn't working",
  enhancement: 'New feature or request',
  documentation: 'Improvements or additions to documentation',
};

/**
 * Hand-written conditions, adapted for pull requests from the issue set that was
 * backtested. A pull request is a change that was made, not a change that was
 * asked for, so every sentence is about what the diff does.
 */
const CRITERIA: Record<Label, string> = {
  bug: 'This pull request fixes a defect: it corrects behaviour that crashed, errored, produced wrong or missing output, or did not match the documentation.',
  enhancement:
    'This pull request adds capability the tool did not have before: a new feature, a new option or flag, wider support, or a behaviour change that adds capability.',
  documentation:
    'What this pull request changes is documentation — the README, the website, guides, examples, help text or translations — rather than the behaviour of the program itself.',
};

// ---------------------------------------------------------------- corpus

interface Sample {
  number: number;
  /** Title with the Conventional Commits prefix removed. */
  title: string;
  body: string;
  author: string;
  truth: Label;
  files: ChangedFile[];
}

const gh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const CONVENTIONAL = /^(\w+)(\([^)]*\))?!?:\s*(.+)$/;

function fetchCorpus(limit: number): Sample[] {
  const raw = JSON.parse(
    gh([
      'pr',
      'list',
      '-R',
      repo,
      '--state',
      'merged',
      '--limit',
      String(limit * 3),
      '--json',
      'number,title,body,author',
    ]),
  ) as { number: number; title: string; body: string; author: { login: string; is_bot?: boolean } }[];

  const samples: Sample[] = [];
  const otherTypes: Record<string, number> = {};

  for (const pull of raw) {
    if (samples.length >= limit) break;
    if (pull.author.is_bot || isBotLogin(pull.author.login)) continue;

    const match = CONVENTIONAL.exec(pull.title);
    if (!match) continue;
    const [, type, , rest] = match;
    const truth = TYPE_TO_LABEL[type.toLowerCase()];
    if (!truth) {
      otherTypes[type.toLowerCase()] = (otherTypes[type.toLowerCase()] ?? 0) + 1;
      continue;
    }

    const files = JSON.parse(gh(['api', `repos/${repo}/pulls/${pull.number}/files`, '--paginate'])) as {
      filename: string;
      status: string;
      patch?: string;
    }[];

    samples.push({
      number: pull.number,
      // The prefix states the answer, so it goes before anything is sent.
      title: rest,
      body: pull.body ?? '',
      author: pull.author.login,
      truth: truth as Label,
      files: files.map((file) => ({ path: file.filename, status: file.status, patch: file.patch })),
    });
    process.stderr.write(`\rfetched ${samples.length}/${limit}`);
  }

  process.stderr.write('\n');
  console.log(`Conventional types seen but not mapped: ${JSON.stringify(otherTypes)}\n`);
  return samples;
}

function loadCorpus(): Sample[] {
  const path = values.cache as string;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Sample[];
  } catch {
    const corpus = fetchCorpus(Number(values.count));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(corpus));
    return corpus;
  }
}

// ---------------------------------------------------------------- variants

type StateVariant = 'text' | 'files' | 'patches';
type Wording = 'zero' | 'criteria';

const STATE_VARIANTS: StateVariant[] = ['text', 'files', 'patches'];

function subjectFor(sample: Sample, variant: StateVariant): LabelSubject {
  const files =
    variant === 'text'
      ? []
      : variant === 'files'
        ? withPatches(sample.files, 0)
        : withPatches(sample.files, maxDiffChars);
  return {
    kind: 'pull_request',
    number: sample.number,
    title: sample.title,
    body: sample.body,
    labels: [],
    author: { login: sample.author, isBot: false },
    files,
  };
}

/** Both wordings ride in one request: same state, independent questions. */
function questionsFor(): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  LABELS.forEach((label, index) => {
    questions[`z${index}`] = {
      type: 'noul',
      instructions: zeroConfigInstructions(label, DESCRIPTIONS[label], 'pull_request'),
    };
    questions[`c${index}`] = { type: 'noul', instructions: CRITERIA[label] };
  });
  return questions;
}

interface Observation {
  truth: Label;
  probabilities: Record<Wording, Record<Label, number>>;
}

async function measure(
  sample: Sample,
  variant: StateVariant,
): Promise<{ observation: Observation; ms: number; tokens: number }> {
  const state = buildState(subjectFor(sample, variant), 6000);
  const response = await ask({ apiKey, model, state, questions: questionsFor() });

  const probabilities = { zero: {}, criteria: {} } as Observation['probabilities'];
  LABELS.forEach((label, index) => {
    const zero = response.answers[`z${index}`];
    const criteria = response.answers[`c${index}`];
    probabilities.zero[label] = zero?.type === 'noul' ? zero.noul : 0;
    probabilities.criteria[label] = criteria?.type === 'noul' ? criteria.noul : 0;
  });

  return {
    observation: { truth: sample.truth, probabilities },
    ms: response.ms,
    tokens: response.usage.input_tokens,
  };
}

/** Small pool: the rate limit is generous, but a burst of hundreds is rude. */
async function pool<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------- scoring

function score(observations: Observation[], wording: Wording): string[] {
  const rows: string[] = [];
  for (const label of LABELS) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const observation of observations) {
      const predicted = observation.probabilities[wording][label] >= threshold;
      const actual = observation.truth === label;
      if (predicted && actual) tp++;
      else if (predicted) fp++;
      else if (actual) fn++;
    }
    const precision = tp + fp === 0 ? Number.NaN : tp / (tp + fp);
    const recall = tp + fn === 0 ? Number.NaN : tp / (tp + fn);
    rows.push(`| ${label} | ${tp + fn} | ${pct(precision)} | ${pct(recall)} | ${tp} | ${fp} | ${fn} |`);
  }
  return rows;
}

const pct = (value: number): string => (Number.isNaN(value) ? '—' : `${Math.round(value * 100)}%`);

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// ---------------------------------------------------------------- run

const thinBody = Number(values['thin-body']);
const corpus: Sample[] = loadCorpus().filter((sample) => thinBody === 0 || sample.body.length < thinBody);
console.log(`${corpus.length} merged non-bot pull requests from ${repo}, threshold ${threshold}, model ${model}\n`);

const truthCounts: Record<string, number> = {};
for (const sample of corpus) truthCounts[sample.truth] = (truthCounts[sample.truth] ?? 0) + 1;
console.log(`Ground truth: ${JSON.stringify(truthCounts)}\n`);

for (const variant of STATE_VARIANTS) {
  const results = await pool(corpus, 8, (sample) => measure(sample, variant));
  const observations = results.map((result) => result.observation);
  const tokens = results.map((result) => result.tokens);
  const latencies = results.map((result) => result.ms);

  console.log(`### state: ${variant}`);
  console.log(`median ${median(latencies)} ms · median ${median(tokens)} input tokens · max ${Math.max(...tokens)}\n`);
  for (const wording of ['zero', 'criteria'] as Wording[]) {
    console.log(`${wording === 'zero' ? 'zero-config' : 'hand-written criteria'}:`);
    console.log('| label | n | precision | recall | tp | fp | fn |');
    console.log('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of score(observations, wording)) console.log(row);
    console.log('');
  }
}
