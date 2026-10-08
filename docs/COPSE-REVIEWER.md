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

Same-repository PRs are reviewed automatically when opened, reopened, updated
or marked ready. The credential-free `copse-review-request.yml` workflow signals
the reviewer, which then runs from trusted `main` through `workflow_run`. This
also gives same-repository Dependabot PRs access to the configured model/App
credentials without using `pull_request_target`.

To start an additional review, open Actions → Copse review → Run workflow,
select `main` and enter the PR number, or run:

```sh
gh workflow run copse-review.yml --repo copse-dev/streaming-markdown --ref main -f pr=123
```

Human initiating/rerunning actors need repository write access. Dependabot can
automatically request reviews only for its own same-repository PRs. The PR must
target `main`, and its head and base must both belong to this repository. Fork
PRs are rejected even when dispatched by a maintainer. A stale request does not
review a newer head; the new push supplies a fresh request. For a draft, add
`copse-review` and push, mark ready or dispatch manually; adding the label alone
does not start a review. `copse-review-skip` opts out. Description edits and
feedback labels do not start another review.

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
artifacts for thirty days. Description summaries are enabled: a completed review
adds or updates Copse's managed summary block while preserving the author's text,
including when no findings need a new review. The same stale-head/base and opt-out
checks apply before updating the description. The integration does not make code
changes. `@copse-review` commands are deferred.

## Checking the result

After a completed review, check the managed summary in the PR description and
the findings artifacts in the Actions run. A review with no findings may post
no new review comment, so the description summary is its visible result. Read
the reported validation limits before treating the review as complete coverage.

## Updating the reviewer

Review the upstream changes and update both the workflow reference and
`reviewer-ref` to the same full commit SHA. Pinning both prevents a change on
Copse's main branch from silently changing this repository's reviewer.

See the upstream [`packages/review/ACTIONS.md`](https://github.com/copse-dev/agent-pane/blob/main/packages/review/ACTIONS.md)
for the dependency policy, optional authentication and supported project limits.
