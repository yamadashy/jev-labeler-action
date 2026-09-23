import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  parseBoolean,
  parseCriteria,
  parseList,
  parseMaxBodyChars,
  parseMaxDiffChars,
  parseThreshold,
} from './core/inputs.js';
import { MAX_FILES, withPatches } from './core/labeling.js';
import { labelSubject } from './core/run.js';
import { subjectFromContext, UnsupportedEventError } from './github/event.js';
import { addLabels, listChangedFiles, listRepoLabels } from './github/labels.js';
import { DEFAULT_MODEL, FIREWALL_MESSAGE } from './jev/client.js';
import { renderSummary } from './summary.js';

export async function run(): Promise<void> {
  const apiKey = core.getInput('api-key', { required: true });
  const token = core.getInput('github-token', { required: true });
  const model = core.getInput('model') || DEFAULT_MODEL;
  const threshold = parseThreshold(core.getInput('threshold'));
  const maxBodyChars = parseMaxBodyChars(core.getInput('max-body-chars'));
  const allowlist = parseList(core.getInput('labels'));
  const excludes = parseList(core.getInput('exclude-labels'));
  const criteria = parseCriteria(core.getInput('criteria'));
  const fallbackLabel = core.getInput('fallback-label').trim() || undefined;
  const dryRun = parseBoolean(core.getInput('dry-run'), false);
  const skipBots = parseBoolean(core.getInput('skip-bots'), true);
  const maxDiffChars = parseMaxDiffChars(core.getInput('max-diff-chars'));

  // Keeps the key out of any log line the action or a dependency might emit.
  core.setSecret(apiKey);

  const subject = subjectFromContext(github.context);
  const octokit = github.getOctokit(token);
  const repo = github.context.repo;

  const repoLabels = await listRepoLabels(octokit, repo);
  core.info(`Repository defines ${repoLabels.length} label(s).`);

  // What a pull request changes says more about its label than its prose does,
  // and the file list comes from the API — this action never checks out the
  // branch or runs anything from it.
  if (subject.kind === 'pull_request' && !(skipBots && subject.author.isBot)) {
    const files = await listChangedFiles(octokit, repo, subject.number, MAX_FILES, maxDiffChars > 0);
    subject.files = withPatches(files, maxDiffChars);
    core.info(`Pull request changes ${files.length} file(s).`);
  }

  const result = await labelSubject(subject, repoLabels, {
    apiKey,
    model,
    threshold,
    maxBodyChars,
    allowlist,
    excludes,
    criteria,
    fallbackLabel,
    skipBots,
  });

  if (result.skippedReason === 'bot-author') {
    core.info(`Skipping: #${subject.number} was opened by the app ${subject.author.login}.`);
  }
  // Not a failure: the key works, and the same text would be refused on every re-run.
  if (result.skippedReason === 'firewall') core.warning(FIREWALL_MESSAGE);

  for (const row of result.rows) {
    if (row.probability !== null) core.info(`${row.label}: ${row.probability.toFixed(2)} (${row.status})`);
  }

  // The summary is written before any mutation, so a failed write to the issue
  // still leaves the evidence behind.
  await core.summary.addRaw(renderSummary(result, subject, threshold, dryRun)).write();

  core.setOutput('labels', JSON.stringify(result.applied));
  core.setOutput('probabilities', JSON.stringify(result.probabilities));
  core.setOutput('model', result.model);

  if (dryRun) {
    core.info(`Dry run: would apply ${result.applied.length ? result.applied.join(', ') : 'nothing'}.`);
    return;
  }

  await addLabels(octokit, repo, subject.number, result.applied);
  core.info(result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Applied nothing.');
}

export async function main(): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof UnsupportedEventError) {
      core.setFailed(error.message);
      return;
    }
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
