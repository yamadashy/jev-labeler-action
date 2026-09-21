/**
 * Local smoke test. Not part of the action.
 *
 * Runs the real labelling core against a real repository's labels and a real
 * issue or pull request, and prints the probability table. Useful for picking a
 * threshold before pointing a workflow at anything.
 *
 *   export TYPESAFE_API_KEY=...
 *   npm run smoke -- --repo yamadashy/repomix --issue 1878
 *   npm run smoke -- --repo yamadashy/repomix --pr 1871
 *
 * Everything on the GitHub side is fetched with the `gh` CLI, so it uses
 * whatever credentials `gh` already has.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseCriteria } from '../src/core/inputs.js';
import { MAX_FILES, withPatches } from '../src/core/labeling.js';
import { labelSubject } from '../src/core/run.js';
import type { ChangedFile, LabelSubject, RepoLabel } from '../src/core/types.js';
import { isBotLogin } from '../src/github/event.js';
import { DEFAULT_MODEL } from '../src/jev/client.js';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    issue: { type: 'string' },
    pr: { type: 'string' },
    threshold: { type: 'string', default: '0.8' },
    model: { type: 'string', default: DEFAULT_MODEL },
    criteria: { type: 'string' },
    'max-diff-chars': { type: 'string', default: '0' },
  },
});

const repo = values.repo;
const number = values.issue ?? values.pr;
const kind = values.pr ? 'pull_request' : 'issue';
if (!repo || !number || (values.issue && values.pr)) {
  console.error(
    'Usage: npm run smoke -- --repo <owner/name> (--issue <number> | --pr <number>) [--threshold 0.8] [--criteria criteria.yml]',
  );
  process.exit(2);
}

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set.');
  process.exit(2);
}

const gh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const repoLabels = JSON.parse(gh(['label', 'list', '-R', repo, '--limit', '200', '--json', 'name,description'])) as {
  name: string;
  description: string;
}[];

const subcommand = kind === 'pull_request' ? 'pr' : 'issue';
const item = JSON.parse(gh([subcommand, 'view', number, '-R', repo, '--json', 'number,title,body,labels,author'])) as {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  author?: { login?: string };
};

const maxDiffChars = Number(values['max-diff-chars']);

function changedFiles(): ChangedFile[] {
  const files = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}/files`, '--paginate'])) as {
    filename: string;
    status: string;
    patch?: string;
  }[];
  const capped = files
    .slice(0, MAX_FILES + 1)
    .map((file) => ({ path: file.filename, status: file.status, patch: file.patch }));
  return withPatches(capped, maxDiffChars);
}

const labels: RepoLabel[] = repoLabels.map((label) => ({
  name: label.name,
  description: label.description === '' ? null : label.description,
}));

// Deliberately pretends it is unlabelled: the point of the smoke test is to see
// what the model would have said on a brand-new issue or pull request.
const subject: LabelSubject = {
  kind,
  number: item.number,
  title: item.title,
  body: item.body ?? '',
  labels: [],
  author: { login: item.author?.login ?? '', isBot: isBotLogin(item.author?.login ?? '') },
  ...(kind === 'pull_request' ? { files: changedFiles() } : {}),
};

const threshold = Number(values.threshold);

const result = await labelSubject(subject, labels, {
  apiKey,
  model: values.model ?? DEFAULT_MODEL,
  threshold,
  maxBodyChars: 6000,
  criteria: values.criteria ? parseCriteria(readFileSync(values.criteria, 'utf8')) : undefined,
});

console.log(`\n${repo}#${item.number} (${kind}): ${item.title}`);
if (subject.files) console.log(`changed files: ${subject.files.length}`);
console.log(`actual labels: ${item.labels.map((label) => label.name).join(', ') || '(none)'}`);
console.log(
  `model ${result.model} · ${result.ms} ms · ${result.usage.input_tokens} input tokens · threshold ${threshold}\n`,
);

const evaluated = result.rows
  .filter((row) => row.probability !== null)
  .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
const width = Math.max(...evaluated.map((row) => row.label.length), 5);

for (const row of evaluated) {
  const probability = (row.probability ?? 0).toFixed(2);
  const mark = row.status === 'applied' ? '*' : ' ';
  console.log(`${mark} ${row.label.padEnd(width)}  ${probability}`);
}

console.log(`\nwould apply: ${result.applied.join(', ') || '(nothing)'}`);
