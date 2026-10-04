# Copse Reviewer

`.github/workflows/copse-review.yml` calls the pinned OSS Copse Reviewer workflow
in `copse-dev/agent-pane`. Grounding and model review run as separate jobs on
this repository's GitHub-hosted runners. No Copse server is involved, and the
workflow does not replace this package's normal CI.

## Repository setup

- Add `COPSE_REVIEW_OPENROUTER_API_KEY` as a repository secret, or grant this repo
  access to a restricted organization secret with that name. A secret stored
  only in agent-pane's `copse-review-models` environment is not inherited here.
- The existing release App installation and `RELEASE_APP_ID` /
  `RELEASE_APP_PRIVATE_KEY` secrets provide the review identity. The review job
  mints a token with only this repository's pull-request write permission.
- Allow the workflow's requested PR-write permission under repository/org policy.

The model defaults to `openai/gpt-6-luna` through OpenRouter. The reusable workflow
accepts model, lens and step/verification limits. A model call sends redacted review
context to the selected provider; runner execution and model use are charged to
the repository/credential owner.

## Starting a review

Ready PRs opened, reopened or marked ready by a collaborator with write access
are reviewed automatically. Add `copse-review` to review a draft or rerun an
existing PR. Remove and re-add the label for a subsequent run. Other label changes
and pushes alone do not start a review. `copse-review-skip` opts out. Maintainers
can also run the workflow manually with a PR number, including a fork PR.

The reviewer pins the PR head and base, reads its conversation, and runs the
detected `build`, `typecheck` and `test` scripts. This package has no lint script,
so this integration does not claim lint validation. Dependencies are installed
offline from a validated, read-only npm cache, with lifecycle scripts disabled.
All project checks and focused verification execute in network-disabled cells.
External GFM/normalizer fixtures and browser checks are not automatically fetched
or run; full coverage and browser evidence remain owned by normal CI.

Findings publish as advisory App reviews, anchored to the reviewed commit. The
workflow checks for stale heads/bases, closed PRs and opt-out labels before posting.
Full findings JSON, SARIF and the model event stream are retained as Actions
artifacts for thirty days. The initial integration neither edits PR descriptions
nor makes code changes. `@copse-review` commands are deferred.

## Updating the reviewer

Review the upstream changes and update both the workflow reference and
`reviewer-ref` to the same full commit SHA. Pinning both prevents a change on
Copse's main branch from silently changing this repository's reviewer.

See the upstream [`packages/review/ACTIONS.md`](https://github.com/copse-dev/agent-pane/blob/main/packages/review/ACTIONS.md)
for the dependency policy, optional authentication and supported project limits.
