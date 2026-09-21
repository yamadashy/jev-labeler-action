/**
 * Local smoke test. Not part of the action.
 *
 * Runs the real labelling core against a real repository's labels and a real
 * issue, and prints the probability table. Useful for picking a threshold before
 * pointing a workflow at anything.
 *
 *   export TYPESAFE_API_KEY=...
 *   npm run smoke -- --repo yamadashy/repomix --issue 1878
 *
 * Labels and the issue are fetched with the `gh` CLI, so it uses whatever
 * credentials `gh` already has.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_EXCLUDE_LABELS, parseCriteria } from '../src/core/inputs.js';
import { labelSubject } from '../src/core/run.js';
import type { LabelSubject, RepoLabel } from '../src/core/types.js';
import { isBotLogin } from '../src/github/event.js';
import { DEFAULT_MODEL } from '../src/jev/client.js';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    issue: { type: 'string' },
    threshold: { type: 'string', default: '0.8' },
    model: { type: 'string', default: DEFAULT_MODEL },
    criteria: { type: 'string' },
  },
});

const repo = values.repo;
const issueNumber = values.issue;
if (!repo || !issueNumber) {
  console.error(
    'Usage: npm run smoke -- --repo <owner/name> --issue <number> [--threshold 0.8] [--criteria criteria.yml]',
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

const issue = JSON.parse(
  gh(['issue', 'view', issueNumber, '-R', repo, '--json', 'number,title,body,labels,author']),
) as {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  author?: { login?: string };
};

const labels: RepoLabel[] = repoLabels.map((label) => ({
  name: label.name,
  description: label.description === '' ? null : label.description,
}));

// Deliberately pretends the issue is unlabelled: the point of the smoke test is
// to see what the model would have said on a brand-new issue.
const subject: LabelSubject = {
  kind: 'issue',
  number: issue.number,
  title: issue.title,
  body: issue.body ?? '',
  labels: [],
  author: { login: issue.author?.login ?? '', isBot: isBotLogin(issue.author?.login ?? '') },
};

const threshold = Number(values.threshold);

const result = await labelSubject(subject, labels, {
  apiKey,
  model: values.model ?? DEFAULT_MODEL,
  threshold,
  maxBodyChars: 6000,
  excludes: DEFAULT_EXCLUDE_LABELS,
  criteria: values.criteria ? parseCriteria(readFileSync(values.criteria, 'utf8')) : undefined,
});

console.log(`\n${repo}#${issue.number}: ${issue.title}`);
console.log(`actual labels: ${issue.labels.map((label) => label.name).join(', ') || '(none)'}`);
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
