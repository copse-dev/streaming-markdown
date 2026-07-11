# Cross-library streaming benchmarks

Published, reproducible numbers comparing this library with the other
streaming-markdown renderers people actually evaluate against
([Streamdown](https://streamdown.ai),
[react-markdown](https://github.com/remarkjs/react-markdown) with and without
the recommended block memoization,
[smd / `streaming-markdown`](https://github.com/thetarnav/streaming-markdown),
and [Incremark](https://github.com/kingshuaishuai/incremark)). Filed as #157;
the harness lives in [`bench/competitors/`](../bench/competitors/).

**These numbers are deliberately not a CI gate.** Competitor installs are
flaky and competitor releases change speed without any action of ours, so the
[`bench-competitors.yml`](../.github/workflows/bench-competitors.yml) workflow
runs on a monthly schedule or manual dispatch and publishes an artifact. Our
own *relative* regression guard (`npm run bench`, #154) is what CI gates on.

## Methodology

Adopted from Incremark's published benchmark
([`benchmark-compare/`](https://github.com/kingshuaishuai/incremark/tree/main/benchmark-compare),
MIT), then extended where their setup under-measures what a streaming UI
actually does:

- **Chunked replay.** Each fixture is streamed in small fixed-size chunks
  (default 5 characters, matching Incremark's harness), appending to an
  accumulated document exactly the way LLM deltas arrive. By default the
  chunk size grows so no fixture exceeds 200 updates (keeps the O(n²)
  full-re-render competitors from dominating wall-clock, and bounds a jsdom
  memory quirk — see below); pass `--parity` for Incremark's exact uncapped
  5-character methodology (best combined with `--only` to compare the
  pipeline-tier parsers, which is all Incremark's own table compares).
- **One process per fixture.** DOMPurify's string-return mode retains ~1–2 MB
  per call under jsdom — surviving GC and window teardown; an upstream jsdom
  retention that real browsers don't exhibit (`bench/competitors/dom-setup.ts`
  documents the probes). Each fixture therefore runs in a child process so
  retention can never accumulate across the corpus, and a competitor crash
  loses one fixture, not the run.
- **Median of runs.** Every (library, fixture) cell is the median-by-total of
  3 measured runs after 1 warmup, with per-update p50/p95/max recorded.
- **Two execution tiers, reported separately:**
  - *Pipeline* — headless per-chunk work, no DOM. This is what Incremark's
    published table measures: its `parser.append()` (incremental mdast build)
    against other libraries' full re-parse. Caveat inherited with the
    methodology: the per-chunk work is **not equivalent** across libraries —
    Incremark builds an AST but renders nothing, Streamdown's
    `parseMarkdownIntoBlocks` only splits blocks with marked's lexer, and our
    entries emit a complete (optionally sanitized) HTML string every chunk.
  - *DOM* — end-to-end: chunks in, live rendered DOM updated per chunk, in
    jsdom so every library pays identical DOM overhead. React-based
    competitors render through `createRoot` + `flushSync` per chunk (what a
    per-delta re-render does in an app); smd and our incremental renderer
    mutate the DOM directly. This is the tier that answers "what does the
    user's frame budget see", and per-update p95/max on the long-transcript
    fixture is the frame-time proxy.
- **Bundle size** — esbuild, browser platform, minified, es2022, code
  splitting; React and declared peer dependencies are external (all React
  competitors assume an existing React app). "Initial" counts the entry plus
  all statically imported chunks; "total" adds lazy chunks.

### Corpus

Incremark's published "6.1× vs Streamdown across 38 real files" corpus is
**not in its repository** — only two of the files are committed. We pin those
two at commit `765e77b` (SHA-256-verified at fetch time, MIT) for direct
comparability, and fill the rest of the corpus with real documents from this
repository plus the code-block-heavy case from #155:

- `incremark/P1.5_COLOR_SYSTEM_REPORT.md`, `incremark/test-md.md` — the two
  committed upstream fixtures (fetched by `fetch-corpus.mts`, gitignored).
- `README.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`,
  `tests/fixtures/terms-of-service-streaming.md` — real docs, mixed prose /
  lists / tables / code.
- `synthetic/code-heavy (#155)` — fenced-code-dominated (TS + Python + JSON),
  the shape where repeated re-highlighting/re-parsing goes super-linear.
- `synthetic/long-transcript` — all of the above concatenated, the
  long-conversation case where incremental architectures separate from
  re-render-everything ones.

### Fairness caveats (read before quoting a number)

- **Work per update differs by design.** Our renderers emit
  **sanitizer-verified HTML** every update (DOMPurify under jsdom — the
  native-Sanitizer fast path measured by `npm run bench:browser` doesn't
  exist there, so our sanitized numbers are worst-case). smd writes DOM text
  nodes with no sanitizer; React-based renderers rely on React's escaping;
  Streamdown additionally hardens URLs and repairs incomplete markdown;
  Incremark's core builds an AST and renders nothing at all.
- **Highlighting:** no highlighter is registered for our renderer,
  react-markdown and smd render code as plain text, so those compare
  markdown work. Streamdown's and Incremark-react's built-in highlighting is
  part of their defaults and left enabled — their code-heavy numbers include
  it.
- **jsdom is not a browser.** Layout, paint, style recalc and CLS do not
  exist in jsdom; the DOM tier measures JS + DOM-tree work only. Real-browser
  frame times / layout-shift measurement is a planned follow-up (the harness
  is structured so a Playwright runner can reuse the same corpus and
  contestants).
- **Versions drift.** Every published table embeds the exact competitor
  versions and machine; compare libraries within one run only, never across
  runs or machines.

## Running it

```bash
npm ci                      # root deps (harness imports src/ directly)
npm ci --prefix bench/competitors   # isolated competitor deps
npm run bench:competitors   # fetches the pinned corpus, runs, writes results/
```

Useful flags (append after `--`): `--parity` (exact Incremark methodology),
`--fixture <regex>`, `--only <regex>` (contestant filter), `--iters N`,
`--chunk N`, `--skip-bundle`, `--no-isolate` (single-process, for debugging),
`--update-docs` (rewrites the results section below). Output lands in
`bench/competitors/results/latest.{json,md}` — the same files the scheduled
workflow uploads as its artifact.

## Results

<!-- bench-results:begin (generated by bench/competitors — do not edit by hand) -->

_No published run yet — run `npm run bench:competitors -- --update-docs`._

<!-- bench-results:end -->
