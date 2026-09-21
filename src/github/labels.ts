import type { getOctokit } from '@actions/github';
import type { ChangedFile, RepoLabel } from '../core/types.js';

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

/**
 * A pull request's changed files, read from the API rather than from a checkout.
 *
 * Stops as soon as the cap is reached: a pull request that regenerated a lockfile
 * and every snapshot can run to thousands of files, and paging through all of
 * them to throw them away is time nobody gets back.
 */
export async function listChangedFiles(
  octokit: Octokit,
  repo: Repo,
  pullNumber: number,
  maxFiles: number,
  withPatch: boolean,
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];

  for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    ...repo,
    pull_number: pullNumber,
    per_page: 100,
  })) {
    for (const file of page.data) {
      files.push({
        path: file.filename,
        status: file.status,
        ...(withPatch && file.patch ? { patch: file.patch } : {}),
      });
    }
    // One extra entry past the cap is enough for the state builder to know the
    // list was cut short.
    if (files.length > maxFiles) return files;
  }

  return files;
}

/** Add labels to an issue. Additive: this endpoint never removes anything. */
export async function addLabels(octokit: Octokit, repo: Repo, issueNumber: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  await octokit.rest.issues.addLabels({ ...repo, issue_number: issueNumber, labels });
}
