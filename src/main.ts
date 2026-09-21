import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  DEFAULT_EXCLUDE_LABELS,
  parseBoolean,
  parseCriteria,
  parseList,
  parseMaxBodyChars,
  parseThreshold,
} from './core/inputs.js';
import { labelSubject } from './core/run.js';
import { subjectFromContext, UnsupportedEventError } from './github/event.js';
import { addLabels, listRepoLabels } from './github/labels.js';
import { DEFAULT_MODEL } from './jev/client.js';
import { renderSummary } from './summary.js';

export async function run(): Promise<void> {
  const apiKey = core.getInput('api-key', { required: true });
  const token = core.getInput('github-token', { required: true });
  const model = core.getInput('model') || DEFAULT_MODEL;
  const threshold = parseThreshold(core.getInput('threshold'));
  const maxBodyChars = parseMaxBodyChars(core.getInput('max-body-chars'));
  const allowlist = parseList(core.getInput('labels'));
  const excludeInput = core.getInput('exclude-labels');
  const excludes = excludeInput.trim() === '' ? DEFAULT_EXCLUDE_LABELS : parseList(excludeInput);
  const criteria = parseCriteria(core.getInput('criteria'));
  const fallbackLabel = core.getInput('fallback-label').trim() || undefined;
  const dryRun = parseBoolean(core.getInput('dry-run'), false);
  const skipBots = parseBoolean(core.getInput('skip-bots'), true);

  // Keeps the key out of any log line the action or a dependency might emit.
  core.setSecret(apiKey);

  const subject = subjectFromContext(github.context);
  const octokit = github.getOctokit(token);
  const repo = github.context.repo;

  const repoLabels = await listRepoLabels(octokit, repo);
  core.info(`Repository defines ${repoLabels.length} label(s).`);

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
    core.info(`Skipping: issue #${subject.number} was opened by the app ${subject.author.login}.`);
  }

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
