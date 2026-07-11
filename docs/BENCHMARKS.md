# Benchmarks & methodology

This library's differentiator is doing incremental-DOM streaming **and** a
sanitized at-rest string over one core, with zero required dependencies. This
page documents how we measure that, the numbers our own harness produces, and
the plan for the cross-library comparison.

> **Status.** The reproducible in-repo harness and our own numbers are here now.
> The head-to-head cross-library comparison
> ([#157](https://github.com/copse-dev/streaming-markdown/issues/157)) is a
> deliberately **non-gating**, out-of-band follow-up — see [Why the cross-library
> comparison is out-of-band](#why-the-cross-library-comparison-is-out-of-band).

## What we measure, and how

Everything below is reproducible from a clean checkout — no hidden setup.

| Dimension | Command | What it captures |
| --- | --- | --- |
| **Streaming throughput / scaling** | `npm run bench` | Median wall-clock to stream each fixture to completion through both emitters, and the **per-doubling growth** of the incremental DOM path (must stay sub-quadratic). |
| **Bundle size** | `npm run size` | Gzipped+minified bytes per entry point, peers external. Gated per-entry. |
| **Correctness under load** | `npm test` | Char-by-char convergence of the two emitters, the adversarial-input corpus, and the CommonMark/GFM conformance baselines. |

The streaming harness (`scripts/bench-streaming.mts`) replays documents
token-by-token at a fixed chunk size so the number of `update()` calls grows with
input length, then reports the growth factor per input doubling. Fixtures span
synthetic worst cases (wide tables, deep footnote sets, code-block-heavy traces)
and a hand-collected **real-document corpus** (`tests/fixtures/bench-corpus/` — an
LLM answer, a README, a changelog) so the guard reflects real content, not only
synthetic shapes.

### Metrics the cross-library harness will add

When the out-of-band comparison lands it will additionally measure, on a shared
corpus streamed through each library:

- **tokens/sec** to a settled render;
- **long-transcript frame times** and **layout shift (CLS)** — the jank a
  re-render-per-token approach accrues;
- **bundle size** delivered to the client;
- the **code-block-heavy** case specifically (Shiki/hljs re-highlight cost
  dominates real traces — see [#155](https://github.com/copse-dev/streaming-markdown/issues/155)).

## Our own numbers

Absolute timings are machine-dependent — treat the **relative** figures as the
contract; regenerate locally with the commands above.

### Bundle size (gzipped + minified, peers external)

The main entry is **~31.8 KB** gzip with **no required dependencies** and imports
no peers. Every optional capability is a separate, opt-in entry that stays out of
the bundle until imported:

| Entry | gzip |
| --- | --- |
| `.` (core: CommonMark + GFM, both emitters, sink sanitizer) | ~31.8 KB |
| `./entities/full` (full HTML5 entity table) | ~1.6 KB |
| `./sanitizers/dompurify`, `./highlighters/highlightjs`, `./diagrams/mermaid`, `./math/katex`, … | < 1 KB each |

highlight.js / Shiki, DOMPurify, mermaid, and KaTeX are optional **peers** — never
in your bundle unless you opt in.

### Streaming scaling (the CI-gated guard)

The incremental DOM path holds a frozen committed prefix and re-renders only the
settled tail, so per-commit work is O(tail) and streaming a document scales
**~linearly** — roughly **1.7–2.3× per input doubling** on the reference machine,
across prose, footnote-heavy, code-block-heavy, and real-document fixtures. A
regression to O(prefix)-per-commit re-rendering pushes that toward 4×; the bench
throws below 3×, so the relative guard fails the build (this is **our** gate — it
depends on no competitor).

## Why the cross-library comparison is out-of-band

The head-to-head numbers vs Streamdown / react-markdown / smd / Incremark are
valuable to publish, but they must **not** be a required CI check:

- installing several competitor packages (plus their peers) on the runner is
  flaky, and a broken competitor install is not a regression we caused;
- "a competitor shipped a faster release" is not our build failing.

So the methodology is adopted here and our **relative** growth guard stays the CI
gate ([#154](https://github.com/copse-dev/streaming-markdown/issues/154)); the
cross-library comparison will run as a **scheduled/manual workflow** and publish
results as an artifact, regenerated per release — tracked on
[#157](https://github.com/copse-dev/streaming-markdown/issues/157).
