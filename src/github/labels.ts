import type { getOctokit } from '@actions/github';
import type { RepoLabel } from '../core/types.js';

type Octokit = ReturnType<typeof getOctokit>;

export interface Repo {
  owner: string;
  repo: string;
}

/**
 * Every label defined on the repository.
 *
 * Paginated: a hundred labels is a common ceiling for a busy repo and the API
 * caps a page there, so a single request would silently truncate the candidate
 * set and quietly stop applying some labels.
 */
export async function listRepoLabels(octokit: Octokit, repo: Repo): Promise<RepoLabel[]> {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    ...repo,
    per_page: 100,
  });
  return labels.map((label) => ({ name: label.name, description: label.description ?? null }));
}

/** Add labels to an issue. Additive: this endpoint never removes anything. */
export async function addLabels(octokit: Octokit, repo: Repo, issueNumber: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  await octokit.rest.issues.addLabels({ ...repo, issue_number: issueNumber, labels });
}
