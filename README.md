<h1 align="center">Jev Issue Labeler</h1>

<p align="center">
  <b>Zero-config AI issue labeling</b>
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

Exclude labels that record a decision or an event rather than a property of the text: `duplicate`,
`good first issue`, `needs more information`, `triage`, `released`.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | *(required)* | TypeSafe API key. |
| `github-token` | `${{ github.token }}` | Needs `issues: write`. |
| `threshold` | `0.8` | Apply a label at or above this probability. |
| `labels` | *(all described labels)* | Allowlist, newline- or comma-separated. |
| `exclude-labels` | `duplicate`, `invalid`, `wontfix`, `good first issue`, `help wanted` | Labels never to apply. |
| `criteria` | *(none)* | YAML map of label to a plain-language condition, replacing its description. |
| `fallback-label` | *(none)* | Applied when nothing clears the threshold. |
| `skip-bots` | `true` | Skip issues opened by bots. |
| `dry-run` | `false` | Write the summary, apply nothing. |
| `model` | `jev-1.13.0` | Pinned so a tuned threshold does not shift when `jev-latest` moves. |
| `max-body-chars` | `6000` | Longer issue bodies are truncated. |

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
- The issue is read from the event payload inside the action, never through a shell.

## Measured

On 270 real [Repomix](https://github.com/yamadashy/repomix) issues with `jev-1.13.0`:

- 40 high-confidence picks disagreed with the existing labels. Read one by one, 38 were correct: the issue had
  been left unlabeled or only marked `triage`. One of the two misses was a bot-authored issue, hence `skip-bots`.
- Hand-written `criteria` are stable at any threshold from `0.5` to `0.9`. Descriptions alone degrade at `0.9`.
- Median 220 ms and $0.000066 per issue. All 270 cost under two cents.

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
