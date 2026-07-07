# 0002 — Leaning into industry benchmarks & evals

Status: proposed

How this repo can adopt external, industry-standard benchmarks and eval corpora
to strengthen its own plumbing — and where it should instead *publish* a
benchmark the industry doesn't have yet. For the invariants and harnesses this
builds on, see [ARCHITECTURE.md](../ARCHITECTURE.md) and decision
[0001](0001-streaming-markdown-vs-remend-streamdown.md).

## The plumbing we already have — three reusable patterns

The repo has quietly converged on three pieces of eval infrastructure, and the
whole proposal below is "feed more industry corpora through them":

1. **Pinned fetch-and-verify corpus loader.** `scripts/fetch-gfm-spec.mts` and
   `scripts/fetch-reference-normalizer.mts` download a corpus from a pinned
   upstream tag/commit, verify a SHA-256, and keep it gitignored. Any external
   corpus can be onboarded this way without vendoring or license entanglement.
2. **Baseline-JSON ratchet.** The CommonMark suite (583/652 examples, spec
   0.31.2) and GFM suite (581/672) don't demand 100% — they pin the exact
   passing set in a committed baseline and fail on *any* delta, with an
   `UPDATE_*_BASELINE=1` escape hatch. Regressions and improvements both
   surface in review. The coverage gate (`scripts/coverage-gate.mts`) is the
   same ratchet for line coverage.
3. **Real-browser harness.** `tests/tt-browser-harness.ts` drives actual
   Chromium (with Trusted Types *enforced*), already used by the e2e suite and
   `bench:browser`. Anything that needs "did script actually execute?" or real
   engine timings — not jsdom approximations — plugs in here.

There's also precedent for mining a competitor's suite: `remend-corpus.test.ts`
adopts remend/streamdown's edge-case *inputs* while asserting our own
invariants. That's the template for every corpus below: **adopt industry
inputs, assert copse invariants.**

## Opportunities, in priority order

### 1. cmark's pathological suite → a streaming time-bomb gate

The CommonMark reference implementation ships `test/pathological_tests.py`:
a curated list of ~40 inputs with known quadratic/exponential parser blowups
(deeply nested brackets, unclosed emphasis runs, backtick storms, link-ref
floods). This is *the* industry corpus for markdown parser complexity bugs —
and it matters more here than for a batch renderer, because streaming
re-tokenizes the tail on every update, so any O(n²) at-rest becomes O(n³)
streamed. We already care (`bench-streaming.mts`'s scaling guard, the
angle-autolink ReDoS fix), but our guard covers three synthetic shapes; cmark's
list is decades of accumulated adversarial ones.

Concretely: fetch-and-verify the corpus (pattern 1), run each input through
`renderMarkdown` **and** a chunked `StreamingMarkdownRenderer` replay under a
generous per-example wall-clock ceiling, in CI. A new quadratic path fails the
suite the day it lands, not when a user pastes 50k nested brackets into a chat.

### 2. Markdown-native XSS corpora through the enforced-TT browser harness

Security is a headline claim (sanitize-at-the-sink, Trusted Types, scheme
validation), and `sanitize.test.ts` covers the classes we've thought of. The
industry has payload lists we haven't imported:

- **markdown-specific XSS payloads** (the widely-referenced
  `cujanovic/Markdown-XSS-Payloads` corpus, ~50 vectors: `javascript:` link
  encodings, image `onerror` smuggling, autolink scheme tricks);
- **OWASP XSS cheat-sheet vectors** for the raw-HTML escape path;
- **DOMPurify's own `expect` corpus** for the pluggable sanitizer backends
  (mXSS classes beyond the two we hand-test).

The eval that makes this *ours*: run each payload not just at rest but
**streamed at multiple chunk boundaries** in the enforced-TT Chromium page,
asserting zero script execution in every prefix frame. Mid-token split points
are an attack surface unique to streaming renderers (`java` + `script:` arriving
in separate chunks), and no markdown library ships a streamed-XSS eval today.
The harness (pattern 3) and the chunking machinery (`tests/split-core.ts`)
already exist; this is corpus plumbing, not new infrastructure.

Adjacent, same motivation: a **ReDoS static scan** (e.g. `recheck`) over every
regex in `src/` as a CI step — we've had one ReDoS already; the class deserves
a gate, not just a regression test for the instance we caught.

### 3. A bundle-size ratchet for the "light by default" claim

"The only runtime dependency is `entities`; highlight.js/DOMPurify/mermaid/KaTeX
are never in your bundle unless you opt in" is marketing without a gate. The
industry standard is `size-limit`: per-export budgets (core entry vs each
optional backend), failing CI when a change drags an optional dep into the core
graph or bloats it past budget. This is the coverage ratchet applied to the
claim users actually feel, and it produces a README badge for free.

### 4. Promote the manual benches into continuous benchmarking

`bench-streaming.mts` says it plainly: "Bench is a manual script, so this gates
local regressions, not CI." The reason — wall-clock noise on shared runners
(and our `CHECKS_RUNNER` self-hosted pool is no quieter) — is exactly what the
industry tooling solves:

- **CodSpeed** (free for OSS) measures instruction counts, not wall-clock, so
  results are deterministic on noisy runners and PRs get a % delta comment;
- or **github-action-benchmark**, which stores trend data on the `gh-pages`
  branch we already deploy.

While promoting it, adopt **markdown-it's `benchmark/samples` corpus** as
fixtures alongside ours — it's the de-facto perf corpus JS markdown parsers
(markdown-it, micromark, marked) compare on, which makes our numbers legible to
people evaluating renderers, not just to us.

### 5. Publish the scores the ratchets already compute

`conformance-baseline.json` and `gfm-conformance-baseline.json` already carry
`summaryBySection` — a per-construct scorecard nobody can see. Cheap wins:

- CI emits shields.io endpoint JSON → **conformance badges** (CommonMark 89%,
  GFM 86%) and a per-section dashboard page on the existing GitHub Pages demo;
- register the renderer on **Babelmark**, the community's live differential
  comparison across ~30 markdown implementations;
- annotate the baseline with a committed **by-design exclusion list** (raw-HTML
  examples that sanitize-at-the-sink deliberately fails, autolink grammar we
  subset), so the published number distinguishes "won't fix" from "gap".

### 6. Let the existing evals drive the backlog: marketed features scoring zero

The GFM ratchet is already an eval telling us something we haven't acted on —
`extensionSummary` shows **Task list items 0/2** and **Autolinks (extension)
0/11** while the README markets both. Likely output-shape mismatches (checkbox
attributes, autolink subsetting) rather than missing features — but that's the
point of leaning in: triage each to "fix the shape" or "move to the by-design
list", so the score means what it says before we publish it (#5).

### 7. Define the streaming benchmark the industry doesn't have

There is no industry benchmark for *streaming* markdown rendering — remend
asserts healed strings, streamdown re-renders per token, and nobody measures
transient-frame quality. We already assert the right invariants internally
(no raw-syntax flash in any prefix frame; convergence with the at-rest render).
Formalizing them as a runnable, renderer-agnostic metric set is both a
contribution and a moat:

- **flash count** — prefix frames where raw structural markers leak as text;
- **convergence** — streamed final state ≡ fresh full render;
- **per-update latency** p50/p99 against the 16 ms frame budget;
- **DOM churn** — mutations per update via `MutationObserver` (the minimal-patch
  claim, measured);

over a published LLM-output-shaped corpus (our ToS/meeting-minutes fixtures are
the seed; synthesize more rather than taking on chat-dataset licenses). Publish
the harness and our numbers on the demo site, and invite the comparison the
0001 doc currently makes in prose.

### 8. Property-based chunking fuzz

`streaming-convergence.test.ts` fuzzes with spec examples × fixed cut patterns.
`fast-check` generalizes both axes: generated markdown mutations × generated
chunkings, shrinking to minimal counterexamples — plus differential checks
against `commonmark.js` on the passing baseline subset. This is the cheapest
way to find the *next* remend-corpus-style edge case before a user does.

## What we deliberately don't chase

- **100% spec conformance.** Sanitize-at-the-sink and the autolink subset are
  design positions; the by-design list (#5) is the honest way to hold them.
- **OSS-Fuzz.** Heavyweight for a TS library; fast-check in CI (#8) buys most
  of the value at none of the integration cost.
- **Real chat-log corpora** (WildChat/LMSYS) for streaming fixtures — license
  friction for marginal realism over synthesized LLM-shaped documents.

## Suggested sequencing

| Step | Effort | Reuses | New gate |
| --- | --- | --- | --- |
| 1. cmark pathological suite | S | patterns 1+2, split-core | streamed complexity ceiling |
| 2. XSS corpora, streamed, TT-enforced | M | pattern 3, split-core | zero-execution eval |
| 3. `size-limit` ratchet | S | ratchet idiom | bundle budget + badge |
| 4. CodSpeed / gh-action-benchmark | M | bench scripts, Pages deploy | perf trend + PR deltas |
| 5. Badges + dashboard + Babelmark | S | baseline JSONs, Pages deploy | visibility |
| 6. Task-list / autolink triage | M | GFM ratchet | honest score |
| 7. Streaming benchmark spec | M | invariant tests, fixtures | the industry's missing eval |
| 8. fast-check fuzz | M | convergence harness | generative regression net |

Steps 1–3 are near-pure corpus plumbing on existing rails and could each land
as a single focused PR.
