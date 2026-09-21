<h1 align="center">Jev Labeler</h1>

<p align="center">
  <b>Zero-config AI labels for issues and PRs</b>
</p>

<p align="center">
  <a href="https://github.com/yamadashy/jev-labeler-action/actions/workflows/ci.yml"><img src="https://github.com/yamadashy/jev-labeler-action/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

Asks [Jev](https://docs.typesafe.ai) one yes/no question per repository label, built from the description the
label already has in GitHub, and adds the labels that clear a threshold.

Jev returns probabilities, never text. A hostile issue body can at worst earn a wrong label: there is no
comment to hijack and no tool to call.

## Quick start

1. Get an API key from [TypeSafe](https://docs.typesafe.ai) and store it as a repository secret:

   ```sh
   gh secret set TYPESAFE_API_KEY
   ```

   This prompts for the value. If the key is already in an environment variable, pipe it in instead:

   ```sh
   printenv TYPESAFE_API_KEY | gh secret set TYPESAFE_API_KEY
   ```

2. Add `.github/workflows/label-issues.yml`:

   ```yaml
   name: Label issues

   on:
     issues:
       types: [opened]

   permissions: {}

   jobs:
     label:
       runs-on: ubuntu-latest
       permissions:
         issues: write
       steps:
         - uses: yamadashy/jev-labeler-action@v0
           with:
             api-key: ${{ secrets.TYPESAFE_API_KEY }}
   ```

The next issue gets every label whose probability is `0.8` or higher. The run's **Job Summary** lists the
probability of each label considered. Add `dry-run: true` to see those numbers without touching the issue.

## Pull requests

Same action, a different trigger. The state Jev sees is the title, the body, and the changed-file list read
from the API. Pull request label sets are usually small, so name them:

```yaml
name: Label pull requests

on:
  pull_request_target:
    types: [opened]

permissions: {}

jobs:
  label:
    runs-on: ubuntu-latest
    permissions:
      issues: write          # labels live on the Issues API, even for a pull request
      pull-requests: read    # to read the changed-file list
    steps:
      - uses: yamadashy/jev-labeler-action@v0
        with:
          api-key: ${{ secrets.TYPESAFE_API_KEY }}
          labels: |
            bug
            enhancement
            documentation
```

`pull_request_target` is what lets this work on pull requests from forks, where `pull_request` has no secrets
and a read-only token. `max-diff-chars` adds diff text to the state; it is `0` by default because patches cost
tokens without improving the answer (see [Measured](#measured)).

## Better labels

**The label description is the prompt.** Improving a description on GitHub improves the labeling, and a label
with no description is skipped.

Some of GitHub's default descriptions mislead when read literally. `question` says *"Further information is
requested"*, which describes a maintainer asking, so it never fires. Override it with `criteria`:

```yaml
- uses: yamadashy/jev-labeler-action@v0
  with:
    api-key: ${{ secrets.TYPESAFE_API_KEY }}
    criteria: |
      question: >-
        The author is asking how to do something with the tool, or asking the maintainers to clarify
        existing behaviour, rather than reporting a defect or requesting a change.
```

On [Repomix #303](https://github.com/yamadashy/repomix/issues/303) that one entry moved `question` from `0.60`
to `0.88`.

Labels that record a decision or an event cannot be read off the text. `duplicate`, `invalid`, `wontfix`,
`good first issue` and `help wanted` are excluded out of the box; add your own, such as `triage` or
`released`, with `exclude-labels`. To have a built-in exclusion considered anyway, name it in `labels` or
`criteria`.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | *(required)* | TypeSafe API key. |
| `github-token` | `${{ github.token }}` | Needs `issues: write`, plus `pull-requests: read` for pull requests. |
| `threshold` | `0.8` | Apply a label at or above this probability. |
| `labels` | *(all described labels)* | Allowlist, newline- or comma-separated. |
| `exclude-labels` | *(none)* | Labels never to apply, on top of the built-in exclusions. |
| `criteria` | *(none)* | YAML map of label to a plain-language condition, replacing its description. |
| `fallback-label` | *(none)* | Applied when nothing clears the threshold. |
| `skip-bots` | `true` | Skip issues opened by bots. |
| `dry-run` | `false` | Write the summary, apply nothing. |
| `model` | `jev-1.13.0` | Pinned so a tuned threshold does not shift when `jev-latest` moves. |
| `max-body-chars` | `6000` | Longer bodies are truncated. |
| `max-diff-chars` | `0` | Pull requests only. Diff characters to send with the file list. |

### Customized example

```yaml
- uses: yamadashy/jev-labeler-action@v0
  with:
    api-key: ${{ secrets.TYPESAFE_API_KEY }}

    # Stricter than the default 0.8: fewer labels, fewer mistakes.
    threshold: 0.9

    # Consider only these labels instead of every described label.
    labels: |
      bug
      enhancement
      question

    # Or keep every label and leave some out. Added to the built-in exclusions.
    # exclude-labels: |
    #   duplicate
    #   wontfix
    #   dependencies

    # Your own words instead of the label's GitHub description.
    # A label listed here is considered even if it has no description.
    criteria: |
      bug: The author reports that the tool crashes, errors, or produces wrong output.
      question: The author asks how to do something rather than reporting a defect.

    # Applied when no label reaches the threshold.
    fallback-label: triage
```

## Outputs

| Output | Description |
| --- | --- |
| `labels` | JSON array of the labels applied (or that would be, in a dry run). |
| `probabilities` | JSON object of label to probability. |
| `model` | The model version that answered. |

## Security

- Jev's whole reply is one number per question. Nothing in the issue can become a comment, a command, or a
  tool call.
- The action only adds labels. It never removes, edits, closes, or comments.
- The issue or pull request is read from the event payload inside the action, never through a shell.
- `pull_request_target` is safe here because the action never checks out, builds, or runs pull request code:
  it reads the payload and asks the API for the file list. **Do not add a step that does.** An
  `actions/checkout` of the pull request head in the same job would hand a fork's code the write token and
  your secrets.

## Measured

On 270 real [Repomix](https://github.com/yamadashy/repomix) issues with `jev-1.13.0`:

- 40 high-confidence picks disagreed with the existing labels. Read one by one, 38 were correct: the issue had
  been left unlabeled or only marked `triage`. One of the two misses was a bot-authored issue, hence `skip-bots`.
- Hand-written `criteria` are stable at any threshold from `0.5` to `0.9`. Descriptions alone degrade at `0.9`.
- Median 220 ms and $0.000066 per issue. All 270 cost under two cents.

On 96 merged pull requests, scored against the Conventional Commits type in their titles (with the prefix
stripped before sending):

- Descriptions alone: `documentation` 95% precision / 86% recall, `enhancement` 100% / 83%, `bug` 100% / 64%.
  Hand-written `criteria` trade precision for recall on `bug` and `enhancement`.
- Sending truncated diffs alongside the file list costs about two and a half times the tokens and did not
  improve any label, hence `max-diff-chars: 0`.

## Contributing

```sh
npm install
npm test
npm run lint
npm run build   # dist/ is committed; CI fails if it is stale
npm run smoke -- --repo yamadashy/repomix --issue 303   # try the core on a real issue
```

## License

[MIT](./LICENSE) © Kazuki Yamada. Unofficial: not affiliated with or endorsed by TypeSafe.
