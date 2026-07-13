/**
 * Cross-library streaming benchmark (#157) — non-gating, published out-of-band.
 *
 * Streams a shared corpus chunk-by-chunk through this library — its string,
 * incremental-DOM, and `/react` wrapper entry points — and each competitor
 * (Streamdown, react-markdown ± block memoization, smd, Incremark) and reports
 * wall-clock totals, per-chunk latency percentiles, throughput,
 * and bundle sizes. Two tiers keep the comparison honest:
 *
 *   pipeline — headless per-chunk parse/render work, the methodology of
 *     Incremark's published benchmark (its `benchmark-compare/benchmark.ts`
 *     measures `parser.append()` against other parsers' full re-parse; nobody
 *     renders DOM). Included so our numbers are comparable with theirs, with
 *     the caveat that each library does different work per chunk (Incremark
 *     builds an AST, Streamdown's `parseMarkdownIntoBlocks` only splits
 *     blocks, ours emits final sanitized/unsanitized HTML strings).
 *
 *   dom — the end-to-end story: markdown chunks in, live rendered DOM
 *     updated per chunk (jsdom; every library pays the same jsdom overhead).
 *     This is what a user-visible streaming chat actually does, and where
 *     re-render-everything approaches go super-linear.
 *
 * Run from bench/competitors: `npm run bench` (fetches the pinned corpus
 * first). Competitor failures never abort the run — a library that throws or
 * fails to import is reported as skipped, which is also why this harness is
 * NOT a CI gate (see .github/workflows/bench-competitors.yml).
 *
 * Each fixture is measured in its own child process (see the child-mode note
 * at the bottom); `--no-isolate` runs everything in-process for debugging.
 *
 * Flags: --iters N (3) --warmup N (1) --chunk N (5) --max-updates N (200)
 *        --parity (exact Incremark methodology: 5-char chunks, no update cap)
 *        --fixture REGEX --only REGEX --skip-bundle --update-docs --no-isolate
 *
 * Numbers are machine-dependent; compare libraries within one run only.
 */
import './dom-setup.ts'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { loadFixtures, chunksOf as chunksOfShared, type Fixture } from './fixtures.mts'

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(benchDir, '../..')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  iters: number
  warmup: number
  chunk: number
  maxUpdates: number
  parity: boolean
  fixture: RegExp | null
  only: RegExp | null
  skipBundle: boolean
  updateDocs: boolean
  isolate: boolean
  childOut: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    iters: 3,
    warmup: 1,
    chunk: 5,
    maxUpdates: 200,
    parity: false,
    fixture: null,
    only: null,
    skipBundle: false,
    updateDocs: false,
    isolate: true,
    childOut: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = (): string => argv[++i] ?? ''
    if (flag === '--iters') args.iters = Math.max(1, Number(next()))
    else if (flag === '--warmup') args.warmup = Math.max(0, Number(next()))
    else if (flag === '--chunk') args.chunk = Math.max(1, Number(next()))
    else if (flag === '--max-updates') args.maxUpdates = Math.max(1, Number(next()))
    else if (flag === '--parity') args.parity = true
    else if (flag === '--fixture') args.fixture = new RegExp(next())
    else if (flag === '--only') args.only = new RegExp(next())
    else if (flag === '--skip-bundle') args.skipBundle = true
    else if (flag === '--update-docs') args.updateDocs = true
    else if (flag === '--no-isolate') args.isolate = false
    else if (flag === '--child-out') args.childOut = next()
    else if (flag !== undefined) {
      console.error(`unknown flag: ${flag}`)
      process.exit(2)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Corpus + chunking live in fixtures.mts, shared verbatim with the
// real-browser tier (bench-browser-live.mts) so both replay the same workload.
function chunksOf(text: string): string[] {
  return chunksOfShared(text, args)
}

// ---------------------------------------------------------------------------
// Contestants
// ---------------------------------------------------------------------------

interface RunHandle {
  /** Called once per streamed chunk. `acc` is the full accumulated text. */
  feed: (chunk: string, acc: string) => void
  /** Called once after the last chunk (finalize/flush). Timed. */
  finish?: (acc: string) => void
  /**
   * The rendered DOM this contestant produced, as an HTML string, read after
   * the final chunk. Powers output validation (see `validate`) — how we prove
   * the timing table compares equivalent work and a fast library isn't fast
   * because it silently rendered less. DOM-tier only; omitted by pipeline
   * contestants that emit no DOM.
   */
  snapshot?: () => string
  /** Untimed cleanup. */
  teardown?: () => void
}

interface Contestant {
  name: string
  tier: 'pipeline' | 'dom'
  version: string
  /** GitHub project URL — rendered as the library's link in every published table. */
  repo: string
  note?: string
  /**
   * The library commits most of its DOM asynchronously, after the synchronous
   * `flushSync` chunk returns (Streamdown highlights/re-parses in effects). The
   * validation read waits for that commit to land (see `settle`) so coverage is
   * truthful; without this the snapshot is taken while the DOM is still empty.
   * Sync renderers leave it unset and are snapshotted immediately.
   */
  deferredRender?: boolean
  setup: () => RunHandle
}

// GitHub project links for every library that appears in a published table.
const REPO = {
  ours: 'https://github.com/copse-dev/streaming-markdown',
  smd: 'https://github.com/thetarnav/streaming-markdown',
  reactMarkdown: 'https://github.com/remarkjs/react-markdown',
  streamdown: 'https://github.com/vercel/streamdown',
  incremark: 'https://github.com/kingshuaishuai/incremark',
  marked: 'https://github.com/markedjs/marked',
} as const

/** Markdown link for a contestant/bundle name — how every table cell renders it. */
const linked = (name: string, repo: string): string => `[${name}](${repo})`

function pkgVersion(pkg: string): string {
  try {
    const fromBench = resolve(benchDir, 'node_modules', pkg, 'package.json')
    const fromRoot = resolve(repoRoot, 'node_modules', pkg, 'package.json')
    const path = existsSync(fromBench) ? fromBench : fromRoot
    return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
  } catch {
    return 'unknown'
  }
}

const ourVersion = (JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string }).version

/**
 * Builds the contestant list, importing each competitor inside a try/catch so
 * a broken install skips that library instead of aborting the benchmark.
 */
async function buildContestants(): Promise<{ contestants: Contestant[]; skipped: string[] }> {
  const contestants: Contestant[] = []
  const skipped: string[] = []

  const ours = await import('../../src/index.ts')

  // --- pipeline tier -------------------------------------------------------
  contestants.push({
    name: 'ours renderMarkdownUnsafe',
    repo: REPO.ours,
    tier: 'pipeline',
    version: ourVersion,
    note: 'full re-render per chunk → unsanitized HTML string',
    setup: () => ({ feed: (_c, acc) => void ours.renderMarkdownUnsafe(acc) }),
  })
  contestants.push({
    name: 'ours renderStreamingMarkdown',
    repo: REPO.ours,
    tier: 'pipeline',
    version: ourVersion,
    note: 'full re-render per chunk → SANITIZED HTML string (does strictly more work than any parse-only competitor)',
    setup: () => ({ feed: (_c, acc) => void ours.renderStreamingMarkdown(acc) }),
  })

  try {
    const { createIncremarkParser } = await import('@incremark/core')
    contestants.push({
      name: 'incremark core.append',
      repo: REPO.incremark,
      tier: 'pipeline',
      version: pkgVersion('@incremark/core'),
      note: 'incremental parse → mdast blocks (no HTML/DOM output)',
      setup: () => {
        const parser = createIncremarkParser()
        return {
          feed: (chunk) => void parser.append(chunk),
          finish: () => void parser.finalize(),
        }
      },
    })
  } catch (e) {
    skipped.push(`incremark core.append: ${String(e)}`)
  }

  try {
    const { parseMarkdownIntoBlocks } = await import('streamdown')
    contestants.push({
      name: 'streamdown parseMarkdownIntoBlocks',
      repo: REPO.streamdown,
      tier: 'pipeline',
      version: pkgVersion('streamdown'),
      note: 'block split of the accumulated text (marked lexer; no render)',
      setup: () => ({ feed: (_c, acc) => void parseMarkdownIntoBlocks(acc) }),
    })
  } catch (e) {
    skipped.push(`streamdown parseMarkdownIntoBlocks: ${String(e)}`)
  }

  try {
    const { Marked } = await import('marked')
    contestants.push({
      name: 'marked full re-parse',
      repo: REPO.marked,
      tier: 'pipeline',
      version: pkgVersion('marked'),
      note: 'accumulated text → HTML string per chunk (the ant-design-x pattern in Incremark’s benchmark)',
      setup: () => {
        const marked = new Marked()
        return { feed: (_c, acc) => void marked.parse(acc) }
      },
    })
  } catch (e) {
    skipped.push(`marked full re-parse: ${String(e)}`)
  }

  // --- dom tier -------------------------------------------------------------

  const domHost = (): { host: HTMLElement; teardown: () => void } => {
    const host = document.createElement('div')
    document.body.append(host)
    return { host, teardown: () => host.remove() }
  }

  contestants.push({
    name: 'ours DOM incremental',
    repo: REPO.ours,
    tier: 'dom',
    version: ourVersion,
    note: 'StreamingMarkdownRenderer.update — incremental, sanitized',
    setup: () => {
      const { host, teardown } = domHost()
      const renderer = new ours.StreamingMarkdownRenderer(host)
      return { feed: (_c, acc) => renderer.update(acc), snapshot: () => host.innerHTML, teardown }
    },
  })
  contestants.push({
    name: 'ours string→innerHTML',
    repo: REPO.ours,
    tier: 'dom',
    version: ourVersion,
    note: 'full sanitized re-render + innerHTML swap per chunk',
    setup: () => {
      const { host, teardown } = domHost()
      return {
        feed: (_c, acc) => {
          host.innerHTML = ours.renderStreamingMarkdown(acc)
        },
        snapshot: () => host.innerHTML,
        teardown,
      }
    },
  })

  // smd-comparable configuration (sanitizer off — smd has none; highlighter
  // already unregistered; math/mermaid/emoji already not loaded). Two shapes:
  // the incremental DOM path under a passthrough backend, and the unsafe
  // string export swapped in via innerHTML. The passthrough backend is injected
  // per-renderer via config (no global swap needed under the ambient config API).
  const { passthroughSanitizerBackend } = await import('./dom-setup.ts')
  contestants.push({
    name: 'ours DOM incremental (unsafe)',
    repo: REPO.ours,
    tier: 'dom',
    version: ourVersion,
    note: 'StreamingMarkdownRenderer.update with sanitization disabled (passthrough backend) — the smd-comparable config',
    setup: () => {
      const { host, teardown } = domHost()
      const renderer = new ours.StreamingMarkdownRenderer(host, {
        sanitizerBackend: passthroughSanitizerBackend,
      })
      return { feed: (_c, acc) => renderer.update(acc), snapshot: () => host.innerHTML, teardown }
    },
  })
  contestants.push({
    name: 'ours unsafe→innerHTML',
    repo: REPO.ours,
    tier: 'dom',
    version: ourVersion,
    note: 'renderMarkdownUnsafe full re-render + innerHTML swap per chunk (no sanitizer)',
    setup: () => {
      const { host, teardown } = domHost()
      return {
        feed: (_c, acc) => {
          host.innerHTML = ours.renderMarkdownUnsafe(acc)
        },
        snapshot: () => host.innerHTML,
        teardown,
      }
    },
  })

  // Like-for-like feature parity with smd: beyond the unsafe variant's
  // sanitizer-off configuration, every grammar feature smd does not support is
  // disabled too — footnotes and link reference definitions (the two per-update
  // definition scans), email autolinks, and raw HTML passthrough (escaped to
  // literal text, smd's behaviour). What stays enabled matches smd's own README
  // checklist: tables, task lists, strikethrough, bare http(s) autolinks. The
  // residual gap to smd in this row is architectural (re-tokenize + tail morph
  // vs. append-only) — see docs/decisions/0004.
  contestants.push({
    name: 'ours DOM incremental (smd parity)',
    repo: REPO.ours,
    tier: 'dom',
    version: ourVersion,
    note: 'unsafe config + footnotes/link-refs/email-autolinks disabled, raw HTML escaped — like-for-like feature set with smd',
    setup: () => {
      const { host, teardown } = domHost()
      const renderer = new ours.StreamingMarkdownRenderer(host, {
        sanitizerBackend: passthroughSanitizerBackend,
        htmlPolicy: 'escape-all',
        emailAutolinks: false,
        footnotes: false,
        linkReferences: false,
      })
      return { feed: (_c, acc) => renderer.update(acc), snapshot: () => host.innerHTML, teardown }
    },
  })

  try {
    const smd = await import('streaming-markdown')
    contestants.push({
      name: 'smd (streaming-markdown)',
      repo: REPO.smd,
      tier: 'dom',
      version: pkgVersion('streaming-markdown'),
      note: 'incremental DOM writer; no sanitizer',
      setup: () => {
        const { host, teardown } = domHost()
        const parser = smd.parser(smd.default_renderer(host))
        return {
          feed: (chunk) => smd.parser_write(parser, chunk),
          finish: () => smd.parser_end(parser),
          snapshot: () => host.innerHTML,
          teardown,
        }
      },
    })
  } catch (e) {
    skipped.push(`smd: ${String(e)}`)
  }

  // React-based competitors share a driver: render into a jsdom root with
  // flushSync so each chunk's work happens synchronously inside the timing
  // window (matching how streaming UIs re-render per delta).
  let reactTools: {
    createElement: typeof import('react').createElement
    memo: typeof import('react').memo
    useMemo: typeof import('react').useMemo
    createRoot: typeof import('react-dom/client').createRoot
    flushSync: typeof import('react-dom').flushSync
  } | null = null
  try {
    const react = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { flushSync } = await import('react-dom')
    reactTools = { createElement: react.createElement, memo: react.memo, useMemo: react.useMemo, createRoot, flushSync }
  } catch (e) {
    skipped.push(`react runtime: ${String(e)}`)
  }

  const reactDriver = (render: (acc: string) => unknown): RunHandle => {
    if (!reactTools) throw new Error('react unavailable')
    const { createRoot, flushSync } = reactTools
    const { host, teardown } = domHost()
    const root = createRoot(host)
    return {
      feed: (_c, acc) => {
        flushSync(() => {
          root.render(render(acc) as never)
        })
      },
      snapshot: () => host.innerHTML,
      teardown: () => {
        root.unmount()
        teardown()
      },
    }
  }

  // Our /react wrapper (src/react.tsx) imports React as a bare specifier, which
  // resolves — from src/ — to the REPO-ROOT node_modules/react. The shared
  // `reactTools`/`reactDriver` above, imported from bench/competitors, resolve
  // react + react-dom to bench/competitors/node_modules — a SECOND, distinct
  // React copy. Rendering our root-React component through the bench-React
  // renderer trips "Invalid hook call" (two React instances → null hook
  // dispatcher). So our wrapper gets its own driver whose createElement,
  // createRoot and flushSync all come from the ROOT node_modules, matching the
  // single React copy the component itself uses. (Competitors don't need this:
  // their components live in bench/competitors/node_modules, same tree as
  // `reactTools`.)
  let oursReactTools: {
    createElement: typeof import('react').createElement
    createRoot: typeof import('react-dom/client').createRoot
    flushSync: typeof import('react-dom').flushSync
  } | null = null
  try {
    const rootUrl = (rel: string): string => pathToFileURL(resolve(repoRoot, 'node_modules', rel)).href
    const { createElement } = (await import(rootUrl('react/index.js'))) as typeof import('react')
    const { flushSync } = (await import(rootUrl('react-dom/index.js'))) as typeof import('react-dom')
    const { createRoot } = (await import(rootUrl('react-dom/client.js'))) as typeof import('react-dom/client')
    oursReactTools = { createElement, createRoot, flushSync }
  } catch (e) {
    skipped.push(`ours react runtime (root copy): ${String(e)}`)
  }

  const oursReactDriver = (render: (acc: string) => unknown): RunHandle => {
    if (!oursReactTools) throw new Error('ours react runtime unavailable')
    const { createRoot, flushSync } = oursReactTools
    const { host, teardown } = domHost()
    const root = createRoot(host)
    return {
      feed: (_c, acc) => {
        flushSync(() => {
          root.render(render(acc) as never)
        })
      },
      snapshot: () => host.innerHTML,
      teardown: () => {
        root.unmount()
        teardown()
      },
    }
  }

  if (oursReactTools) {
    const ort = oursReactTools
    // Our own `@copse/streaming-markdown/react` wrapper as an apples-to-apples
    // React entry: `<StreamingMarkdown markdown={acc}/>` re-renders per chunk but
    // drives the incremental `StreamingMarkdownRenderer.update()` under the hood
    // (not a re-render-everything), sanitized via the process-default backend.
    // Compare it against `streamdown` / `react-markdown` / `incremark react`;
    // `ours DOM incremental` above is the same engine without the React layer.
    try {
      const { StreamingMarkdown } = await import('../../src/react.tsx')
      contestants.push({
        name: 'ours react (StreamingMarkdown)',
        repo: REPO.ours,
        tier: 'dom',
        version: ourVersion,
        note: 'our /react wrapper: <StreamingMarkdown> drives StreamingMarkdownRenderer.update() — incremental, sanitized',
        setup: () => oursReactDriver((acc) => ort.createElement(StreamingMarkdown as never, { markdown: acc })),
      })
    } catch (e) {
      skipped.push(`ours react: ${String(e)}`)
    }
  }

  if (reactTools) {
    const rt = reactTools

    try {
      const Markdown = (await import('react-markdown')).default
      contestants.push({
        name: 'react-markdown',
        repo: REPO.reactMarkdown,
        tier: 'dom',
        version: pkgVersion('react-markdown'),
        note: 'naive: whole document re-rendered per chunk',
        setup: () => reactDriver((acc) => rt.createElement(Markdown, null, acc)),
      })

      // The memoized-blocks pattern recommended for streaming (and used
      // internally by Streamdown): split the accumulated text into blocks with
      // marked's lexer and memoize per block, so completed blocks skip
      // re-render and only the trailing block does markdown work per chunk.
      const { marked } = await import('marked')
      const Block = rt.memo(
        (props: { content: string }) => rt.createElement(Markdown, null, props.content),
        (prev, next) => prev.content === next.content,
      )
      const MemoizedMarkdown = (props: { content: string }): unknown => {
        const blocks = rt.useMemo(() => marked.lexer(props.content).map((token) => token.raw), [props.content])
        return blocks.map((raw, i) => rt.createElement(Block, { key: i, content: raw }))
      }
      contestants.push({
        name: 'react-markdown + memo blocks',
        repo: REPO.reactMarkdown,
        tier: 'dom',
        version: pkgVersion('react-markdown'),
        note: 'marked.lexer block split + per-block memo',
        setup: () => reactDriver((acc) => rt.createElement(MemoizedMarkdown as never, { content: acc })),
      })
    } catch (e) {
      skipped.push(`react-markdown: ${String(e)}`)
    }

    try {
      const { Streamdown } = await import('streamdown')
      contestants.push({
        name: 'streamdown',
        repo: REPO.streamdown,
        tier: 'dom',
        version: pkgVersion('streamdown'),
        note: 'defaults (internal block memo, hardening, incomplete-markdown repair)',
        deferredRender: true,
        setup: () => reactDriver((acc) => rt.createElement(Streamdown as never, null, acc)),
      })
    } catch (e) {
      skipped.push(`streamdown: ${String(e)}`)
    }

    try {
      const { Incremark, DefinitionsProvider } = await import('@incremark/react')
      const { createIncremarkParser } = await import('@incremark/core')
      contestants.push({
        name: 'incremark react',
        repo: REPO.incremark,
        tier: 'dom',
        version: pkgVersion('@incremark/react'),
        note: 'core parser.append per chunk + <Incremark blocks> renderer',
        setup: () => {
          const { createElement, createRoot, flushSync } = rt
          const parser = createIncremarkParser()
          const { host, teardown } = domHost()
          const root = createRoot(host)
          const renderBlocks = (pending: unknown[]): void => {
            const blocks = [...parser.getCompletedBlocks(), ...pending]
            flushSync(() => {
              root.render(
                createElement(DefinitionsProvider as never, null as never, createElement(Incremark as never, { blocks } as never)) as never,
              )
            })
          }
          return {
            feed: (chunk) => {
              renderBlocks(parser.append(chunk).pending as unknown[])
            },
            finish: () => {
              renderBlocks(parser.finalize().pending as unknown[])
            },
            snapshot: () => host.innerHTML,
            teardown: () => {
              root.unmount()
              teardown()
            },
          }
        },
      })
    } catch (e) {
      skipped.push(`incremark react: ${String(e)}`)
    }
  }

  return {
    contestants: args.only ? contestants.filter((c) => args.only?.test(c.name)) : contestants,
    skipped,
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface RunStats {
  totalMs: number
  updates: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  charsPerSec: number
  /**
   * What this contestant actually rendered (DOM tier only; see `validate`).
   * Attached in `measureFixture` after timing, so it rides the same child→
   * parent JSON as the stats. Absent for pipeline contestants.
   */
  validation?: ValidationMetrics | null
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)] ?? 0
}

function runOnce(contestant: Contestant, chunks: string[], totalChars: number): RunStats {
  const handle = contestant.setup()
  const durations: number[] = []
  let acc = ''
  try {
    for (const chunk of chunks) {
      acc += chunk
      const start = performance.now()
      handle.feed(chunk, acc)
      durations.push(performance.now() - start)
    }
    if (handle.finish) {
      const start = performance.now()
      handle.finish(acc)
      durations.push(performance.now() - start)
    }
  } finally {
    handle.teardown?.()
  }
  const totalMs = durations.reduce((a, x) => a + x, 0)
  const sorted = [...durations].sort((a, b) => a - b)
  return {
    totalMs,
    updates: chunks.length,
    meanMs: totalMs / Math.max(1, durations.length),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    charsPerSec: totalMs > 0 ? (totalChars / totalMs) * 1000 : 0,
  }
}

/** Median-by-total run out of `iters` measured runs (after `warmup` unmeasured). */
function measure(contestant: Contestant, chunks: string[], totalChars: number): RunStats | { error: string } {
  try {
    for (let i = 0; i < args.warmup; i++) runOnce(contestant, chunks, totalChars)
    const runs: RunStats[] = []
    for (let i = 0; i < args.iters; i++) runs.push(runOnce(contestant, chunks, totalChars))
    runs.sort((a, b) => a.totalMs - b.totalMs)
    return runs[Math.floor(runs.length / 2)] ?? runs[0] ?? { error: 'no runs' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------
//
// Timing alone can't be trusted across libraries: a renderer that silently
// drops content, or collapses everything into one undifferentiated text blob,
// would post great numbers for the wrong reason. So after a contestant streams
// a whole fixture we read its rendered DOM back and measure WHAT it produced,
// not how fast. The metrics are computed identically for every library, so the
// comparison is fair; near-identical rows are the proof that the timing table
// above compares equivalent work (see docs/BENCHMARKS.md).

interface ValidationMetrics {
  /** Visible characters in the rendered DOM (whitespace-collapsed textContent). */
  textLen: number
  /** Fraction [0,1] of the source's word tokens that appear in the visible text. */
  coverage: number
  headings: number
  /** `<pre>` blocks — fenced/indented code. */
  codeBlocks: number
  tables: number
  listItems: number
  links: number
  blockquotes: number
  /** `<em>`/`<strong>`/`<b>`/`<i>` — inline emphasis. */
  emphasis: number
}

/**
 * Word tokens (alphanumeric runs, length ≥ 4, lowercased) in a piece of text.
 * The ≥ 4 floor drops markdown punctuation and one/two-letter noise while
 * keeping real words and code identifiers; the same tokenizer runs over the
 * source and over each library's rendered text so coverage is apples-to-apples.
 */
function wordTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]{4,}/g)) tokens.add(m[0])
  return tokens
}

/** Scratch element reused to parse each contestant's snapshot for measurement. */
const validationScratch = document.createElement('div')

/**
 * Let an asynchronous renderer settle before we read its DOM. Streamdown commits
 * most of its output *after* the synchronous `flushSync` chunk returns: the DOM
 * is near-empty for ~1s, then the whole document lands in a single burst (its
 * highlight/parse effects resolving), then stays stable. Snapshotting
 * immediately would report near-zero coverage for a library that in fact renders
 * everything — so we poll across macrotasks and wait for that deferred burst.
 *
 * "Stop on first no-change" is wrong here: two empty reads one tick apart look
 * stable only because the async work hasn't *started*. So we wait until the DOM
 * has grown past its post-stream size AND then held quiet for `quietMs` (the
 * burst has fully committed), with a `fallbackMs` escape if a fixture genuinely
 * rendered synchronously and never grows, and a hard `maxMs` cap. Only
 * `deferredRender` contestants run this; sync renderers are already final and
 * are snapshotted directly (see `validate`). NOTE this corrects the *validation*
 * read only — the timing table still measures the synchronous window, so an
 * async renderer's DOM-tier time understates its real per-update cost
 * (documented in docs/BENCHMARKS.md).
 */
async function settle(
  snapshot: () => string,
  { quietMs = 400, stepMs = 50, fallbackMs = 1500, maxMs = 20000 } = {},
): Promise<string> {
  const start = performance.now()
  const initialLen = snapshot().length
  let prev = snapshot()
  let lastChange = start
  let grew = false
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, stepMs))
    const next = snapshot()
    const now = performance.now()
    if (next !== prev) {
      if (next.length > initialLen) grew = true
      prev = next
      lastChange = now
    }
    if (now - start >= maxMs) return next
    if (now - lastChange >= quietMs && (grew || now - start >= fallbackMs)) return next
  }
}

/**
 * Stream the whole fixture through a contestant once (unmeasured) and measure
 * its final rendered DOM. Returns null for pipeline contestants (no DOM to
 * inspect) or if the library exposes no snapshot.
 */
async function validate(
  contestant: Contestant,
  chunks: string[],
  expected: Set<string>,
): Promise<ValidationMetrics | null> {
  if (contestant.tier !== 'dom') return null
  const handle = contestant.setup()
  if (!handle.snapshot) {
    handle.teardown?.()
    return null
  }
  const snapshot = handle.snapshot
  let html = ''
  try {
    let acc = ''
    for (const chunk of chunks) {
      acc += chunk
      handle.feed(chunk, acc)
    }
    handle.finish?.(acc)
    // Sync renderers are already final post-stream; only async ones need the
    // wait-for-deferred-burst poll (see `settle` / `Contestant.deferredRender`).
    html = contestant.deferredRender ? await settle(snapshot) : snapshot()
  } finally {
    handle.teardown?.()
  }
  validationScratch.innerHTML = html
  const text = (validationScratch.textContent ?? '').replace(/\s+/g, ' ').trim()
  const rendered = wordTokens(text)
  let present = 0
  for (const token of expected) if (rendered.has(token)) present++
  const count = (selector: string): number => validationScratch.querySelectorAll(selector).length
  const metrics: ValidationMetrics = {
    textLen: text.length,
    coverage: expected.size > 0 ? present / expected.size : 1,
    headings: count('h1,h2,h3,h4,h5,h6'),
    codeBlocks: count('pre'),
    tables: count('table'),
    listItems: count('li'),
    links: count('a'),
    blockquotes: count('blockquote'),
    emphasis: count('em,strong,b,i'),
  }
  validationScratch.replaceChildren()
  return metrics
}

// ---------------------------------------------------------------------------
// Bundle size
// ---------------------------------------------------------------------------

interface BundleResult {
  name: string
  repo: string
  entryMinBytes: number
  entryGzBytes: number
  totalMinBytes: number
  totalGzBytes: number
  files: number
  note: string
}

async function measureBundles(): Promise<{ bundles: BundleResult[]; skipped: string[] }> {
  const bundles: BundleResult[] = []
  const skipped: string[] = []
  let esbuild: typeof import('esbuild')
  try {
    esbuild = await import('esbuild')
  } catch (e) {
    return { bundles, skipped: [`esbuild unavailable (run npm ci at the repo root): ${String(e)}`] }
  }

  const REACT_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']
  const entries: { name: string; repo: string; contents: string; external: string[]; note: string }[] = [
    {
      name: 'ours (DOM + string core)',
      repo: REPO.ours,
      contents: "export { StreamingMarkdownRenderer, renderStreamingMarkdown } from '../../src/index.ts'",
      external: ['dompurify', 'entities', 'highlight.js', 'shiki', 'katex', 'mermaid'],
      note: 'optional peers external (native Sanitizer path)',
    },
    {
      name: 'smd (streaming-markdown)',
      repo: REPO.smd,
      contents: "export * from 'streaming-markdown'",
      external: [],
      note: 'dependency-free',
    },
    {
      name: 'react-markdown',
      repo: REPO.reactMarkdown,
      contents: "export { default } from 'react-markdown'",
      external: REACT_EXTERNALS,
      note: 'React runtime external (peer)',
    },
    {
      name: 'streamdown',
      repo: REPO.streamdown,
      contents: "export { Streamdown } from 'streamdown'",
      external: REACT_EXTERNALS,
      note: 'React runtime external (peer); lazy chunks = mermaid etc.',
    },
    {
      name: 'incremark (@incremark/core)',
      repo: REPO.incremark,
      contents: "export { createIncremarkParser } from '@incremark/core'",
      external: [],
      note: 'parser only — no renderer',
    },
    {
      name: 'incremark (@incremark/react)',
      repo: REPO.incremark,
      contents: "export { Incremark, useIncremark } from '@incremark/react'",
      external: [...REACT_EXTERNALS, 'katex', 'mermaid'],
      note: 'React runtime + katex/mermaid peers external; shiki bundles',
    },
  ]

  for (const entry of entries) {
    try {
      const result = await esbuild.build({
        stdin: { contents: entry.contents, resolveDir: benchDir, loader: 'ts', sourcefile: 'entry.ts' },
        bundle: true,
        write: false,
        minify: true,
        format: 'esm',
        splitting: true,
        platform: 'browser',
        target: 'es2022',
        outdir: 'bundle-out',
        metafile: true,
        logLevel: 'silent',
        loader: { '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.png': 'dataurl', '.svg': 'dataurl' },
        external: entry.external,
      })
      const outputs = result.metafile?.outputs ?? {}
      // "Initial" = the entry chunk plus every chunk statically imported from
      // it (all load before first render); dynamic imports are lazy-only.
      const initialPaths = new Set<string>()
      const queue = Object.entries(outputs)
        .filter(([, meta]) => meta.entryPoint)
        .map(([path]) => path)
      while (queue.length > 0) {
        const path = queue.pop()
        if (path === undefined || initialPaths.has(path)) continue
        initialPaths.add(path)
        for (const imp of outputs[path]?.imports ?? []) {
          if (imp.kind !== 'dynamic-import' && !imp.external) queue.push(imp.path)
        }
      }
      let entryMin = 0
      let entryGz = 0
      let totalMin = 0
      let totalGz = 0
      for (const file of result.outputFiles ?? []) {
        const rel = file.path.slice(file.path.indexOf('bundle-out'))
        const gz = gzipSync(file.contents).length
        totalMin += file.contents.length
        totalGz += gz
        if (initialPaths.has(rel) || [...initialPaths].some((p) => file.path.endsWith(p))) {
          entryMin += file.contents.length
          entryGz += gz
        }
      }
      bundles.push({
        name: entry.name,
        repo: entry.repo,
        entryMinBytes: entryMin,
        entryGzBytes: entryGz,
        totalMinBytes: totalMin,
        totalGzBytes: totalGz,
        files: result.outputFiles?.length ?? 0,
        note: entry.note,
      })
    } catch (e) {
      skipped.push(`bundle ${entry.name}: ${e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e)}`)
    }
  }
  return { bundles, skipped }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`
const ms = (v: number): string => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2))

function renderMatrix(
  tier: 'pipeline' | 'dom',
  contestants: Contestant[],
  fixtures: Fixture[],
  results: Map<string, Map<string, RunStats | { error: string }>>,
): string[] {
  const libs = contestants.filter((c) => c.tier === tier)
  const lines: string[] = []
  const header = ['fixture', 'chars', 'updates', ...libs.map((c) => linked(c.name, c.repo))]
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`| :-- | --: | --: | ${libs.map(() => '--:').join(' | ')} |`)
  for (const fixture of fixtures) {
    const perLib = results.get(fixture.name)
    if (!perLib) continue
    const updates = chunksOf(fixture.text).length
    const cells = libs.map((c) => {
      const r = perLib.get(c.name)
      if (!r) return '—'
      return 'error' in r ? 'skipped' : `${ms(r.totalMs)} ms`
    })
    lines.push(`| ${fixture.name} | ${String(fixture.text.length)} | ${String(updates)} | ${cells.join(' | ')} |`)
  }
  return lines
}

function renderTailLatency(
  contestants: Contestant[],
  fixtureName: string,
  results: Map<string, Map<string, RunStats | { error: string }>>,
): string[] {
  const perLib = results.get(fixtureName)
  if (!perLib) return []
  const lines: string[] = []
  lines.push('| library | mean/update | p50 | p95 | max |')
  lines.push('| :-- | --: | --: | --: | --: |')
  for (const c of contestants.filter((c) => c.tier === 'dom')) {
    const r = perLib.get(c.name)
    if (!r || 'error' in r) continue
    lines.push(
      `| ${linked(c.name, c.repo)} | ${ms(r.meanMs)} ms | ${ms(r.p50Ms)} ms | ${ms(r.p95Ms)} ms | ${ms(r.maxMs)} ms |`,
    )
  }
  return lines
}

function renderBundles(bundles: BundleResult[]): string[] {
  const lines: string[] = []
  lines.push('| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |')
  lines.push('| :-- | --: | --: | --: | --: | :-- |')
  for (const b of bundles) {
    lines.push(
      `| ${linked(b.name, b.repo)} | ${kb(b.entryMinBytes)} | ${kb(b.entryGzBytes)} | ${kb(b.totalMinBytes)} | ${kb(b.totalGzBytes)} | ${b.note} |`,
    )
  }
  return lines
}

/** Per-fixture visible-text coverage for every DOM contestant — the at-a-glance
 * "is anyone winning by rendering less?" view. Columns that track together mean
 * the timing table on the same fixtures compares equivalent output. */
function renderValidationCoverage(
  contestants: Contestant[],
  fixtures: Fixture[],
  results: Map<string, Map<string, RunStats | { error: string }>>,
): string[] {
  const libs = contestants.filter((c) => c.tier === 'dom')
  const lines: string[] = []
  lines.push(`| fixture | ${libs.map((c) => linked(c.name, c.repo)).join(' | ')} |`)
  lines.push(`| :-- | ${libs.map(() => '--:').join(' | ')} |`)
  for (const fixture of fixtures) {
    const perLib = results.get(fixture.name)
    if (!perLib) continue
    const cells = libs.map((c) => {
      const r = perLib.get(c.name)
      if (!r || 'error' in r || !r.validation) return '—'
      return `${(r.validation.coverage * 100).toFixed(1)}%`
    })
    lines.push(`| ${fixture.name} | ${cells.join(' | ')} |`)
  }
  return lines
}

/** Rendered-structure breakdown for one fixture: what each DOM contestant
 * actually produced (visible text, coverage, element counts). Rows that track
 * across libraries are the proof a fast library rendered the same document. */
function renderValidationStructure(
  contestants: Contestant[],
  fixtureName: string,
  results: Map<string, Map<string, RunStats | { error: string }>>,
): string[] {
  const perLib = results.get(fixtureName)
  if (!perLib) return []
  const lines: string[] = []
  lines.push('| library | visible text | coverage | headings | code | tables | list items | links | emphasis |')
  lines.push('| :-- | --: | --: | --: | --: | --: | --: | --: | --: |')
  for (const c of contestants.filter((c) => c.tier === 'dom')) {
    const r = perLib.get(c.name)
    if (!r || 'error' in r || !r.validation) continue
    const v = r.validation
    lines.push(
      `| ${linked(c.name, c.repo)} | ${String(v.textLen)} chars | ${(v.coverage * 100).toFixed(1)}% | ` +
        `${String(v.headings)} | ${String(v.codeBlocks)} | ${String(v.tables)} | ${String(v.listItems)} | ` +
        `${String(v.links)} | ${String(v.emphasis)} |`,
    )
  }
  return lines
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const fixtures = loadFixtures(args.fixture)
const { contestants, skipped } = await buildContestants()

async function measureFixture(
  fixture: Fixture,
  into: Map<string, Map<string, RunStats | { error: string }>>,
): Promise<void> {
  const chunks = chunksOf(fixture.text)
  const expected = wordTokens(fixture.text)
  const perLib = new Map<string, RunStats | { error: string }>()
  into.set(fixture.name, perLib)
  console.log(`fixture ${fixture.name} — ${String(fixture.text.length)} chars, ${String(chunks.length)} updates`)
  for (const contestant of contestants) {
    const stats = measure(contestant, chunks, fixture.text.length)
    perLib.set(contestant.name, stats)
    if ('error' in stats) {
      console.log(`  ${contestant.name.padEnd(34)} SKIPPED: ${stats.error}`)
      skipped.push(`${contestant.name} on ${fixture.name}: ${stats.error}`)
    } else {
      // One extra unmeasured pass reads back the rendered DOM so we can prove
      // this cell's speed reflects equivalent output, not dropped content.
      stats.validation = await validate(contestant, chunks, expected)
      const cover = stats.validation ? ` cover ${(stats.validation.coverage * 100).toFixed(1)}%` : ''
      console.log(
        `  ${contestant.name.padEnd(34)} [${contestant.tier.padEnd(8)}] total ${ms(stats.totalMs).padStart(8)} ms  ` +
          `p50 ${ms(stats.p50Ms).padStart(7)}  p95 ${ms(stats.p95Ms).padStart(7)}  max ${ms(stats.maxMs).padStart(7)}  ` +
          `${(stats.charsPerSec / 1000).toFixed(0).padStart(6)}k chars/s${cover}`,
      )
    }
  }
  console.log()
}

// Child mode: measure the (already --fixture/--only-filtered) work in THIS
// process and emit raw results as JSON for the parent. Exists because
// DOMPurify's string path retains ~1-2 MB per sanitize under jsdom (surviving
// GC and even window teardown — an upstream jsdom retention, not present in
// real browsers), so a whole-corpus run in one process eventually OOMs no
// matter the heap. The parent spawns one child per (fixture × contestant)
// cell, capping retention at a single contestant's runs — and a competitor
// crash loses one cell, not the run.
if (args.childOut) {
  const childResults = new Map<string, Map<string, RunStats | { error: string }>>()
  for (const fixture of fixtures) await measureFixture(fixture, childResults)
  writeFileSync(
    args.childOut,
    JSON.stringify({
      results: Object.fromEntries([...childResults].map(([f, m]) => [f, Object.fromEntries(m)])),
      skipped,
    }),
  )
  process.exit(0)
}

console.log(
  `cross-library streaming bench (#157) — iters=${String(args.iters)} warmup=${String(args.warmup)} ` +
    `chunk=${String(args.chunk)}${args.parity ? ' (parity: uncapped)' : ` max-updates=${String(args.maxUpdates)}`} ` +
    `isolate=${args.isolate ? 'per-fixture' : 'off'} (node ${process.version}, ${cpus()[0]?.model ?? 'unknown cpu'})\n`,
)

const results = new Map<string, Map<string, RunStats | { error: string }>>()
if (args.isolate) {
  mkdirSync(resolve(benchDir, 'results'), { recursive: true })
  const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tsxCli = resolve(benchDir, 'node_modules/tsx/dist/cli.mjs')
  const script = fileURLToPath(import.meta.url)
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i]
    if (!fixture) continue
    const perLib = new Map<string, RunStats | { error: string }>()
    results.set(fixture.name, perLib)
    console.log(`fixture ${fixture.name} — one child process per contestant`)
    for (const contestant of contestants) {
      const partial = resolve(benchDir, `results/.partial-${String(i)}.json`)
      const child = spawnSync(
        process.execPath,
        [
          tsxCli,
          script,
          '--fixture',
          `^${escapeRegExp(fixture.name)}$`,
          '--only',
          `^${escapeRegExp(contestant.name)}$`,
          '--child-out',
          partial,
          ...['--iters', String(args.iters), '--warmup', String(args.warmup), '--chunk', String(args.chunk)],
          ...['--max-updates', String(args.maxUpdates)],
          ...(args.parity ? ['--parity'] : []),
        ],
        {
          stdio: ['ignore', 'inherit', 'inherit'],
          cwd: benchDir,
          env: {
            ...process.env,
            // The jsdom sanitize retention (see child-mode note) accumulates
            // ~5 GB over one sanitizing contestant's passes on the largest
            // fixture (1 warmup + 3 measured + 1 validation); children get a
            // fixed 8 GB ceiling (appended, so it wins over any inherited
            // limit) since only one child runs at a time.
            NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --max-old-space-size=8192`.trim(),
          },
        },
      )
      if (child.status === 0 && existsSync(partial)) {
        const partialJson = JSON.parse(readFileSync(partial, 'utf8')) as {
          results: Record<string, Record<string, RunStats | { error: string }>>
          skipped: string[]
        }
        const cell = partialJson.results[fixture.name]?.[contestant.name]
        perLib.set(contestant.name, cell ?? { error: 'child produced no result' })
        skipped.push(...partialJson.skipped)
        rmSync(partial, { force: true })
      } else {
        console.error(`  ${contestant.name} on ${fixture.name}: child exited ${String(child.status)} — recorded as skipped`)
        skipped.push(`${contestant.name} on ${fixture.name}: child process exited ${String(child.status)} (crash/OOM)`)
        perLib.set(contestant.name, { error: 'child crashed' })
      }
    }
    console.log()
  }
} else {
  for (const fixture of fixtures) await measureFixture(fixture, results)
}

const bundleReport = args.skipBundle ? { bundles: [], skipped: [] } : await measureBundles()
skipped.push(...bundleReport.skipped)

// --- markdown report -------------------------------------------------------

const reportLines: string[] = []
reportLines.push(
  `_Last run: ${new Date().toISOString().slice(0, 10)} — node ${process.version}, ${cpus()[0]?.model ?? 'unknown cpu'}, ` +
    `chunk=${String(args.chunk)}${args.parity ? ' (parity mode, uncapped)' : `, capped at ${String(args.maxUpdates)} updates/fixture`}, ` +
    `median of ${String(args.iters)} runs. Versions: ours ${ourVersion}, ` +
    contestants
      .filter((c, i, all) => all.findIndex((x) => x.version === c.version && x.name.split(' ')[0] === c.name.split(' ')[0]) === i)
      .filter((c) => !c.name.startsWith('ours'))
      .map((c) => `${c.name.split(' ')[0] ?? ''} ${c.version}`)
      .join(', ') +
    '._',
)
reportLines.push('')
reportLines.push('### End-to-end: streamed chunks → live DOM (jsdom)')
reportLines.push('')
reportLines.push(...renderMatrix('dom', contestants, fixtures, results))
reportLines.push('')
reportLines.push('### Per-update latency on the long transcript (DOM tier)')
reportLines.push('')
reportLines.push(...renderTailLatency(contestants, 'synthetic/long-transcript', results))
reportLines.push('')
reportLines.push('### Output validation — did every library render the same corpus?')
reportLines.push('')
reportLines.push(
  'After each contestant streams a fixture, its rendered DOM is read back and measured — so the timing table ' +
    'above can be trusted to compare equivalent work, not reward a library for silently dropping content. Same ' +
    'metric for every library. Word-token coverage of the visible text, per fixture (columns that track together ' +
    'mean everyone rendered the same document):',
)
reportLines.push('')
reportLines.push(...renderValidationCoverage(contestants, fixtures, results))
reportLines.push('')
reportLines.push(
  'Rendered structure on the long transcript — element counts should track across libraries (the ' +
    '`raw-html-details` fixture is exempt: ours deliberately holds the tail inside the open `<details>`, so its ' +
    'coverage there is expected to differ — see the corpus note):',
)
reportLines.push('')
reportLines.push(...renderValidationStructure(contestants, 'synthetic/long-transcript', results))
reportLines.push('')
reportLines.push('### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)')
reportLines.push('')
reportLines.push(...renderMatrix('pipeline', contestants, fixtures, results))
if (bundleReport.bundles.length > 0) {
  reportLines.push('')
  reportLines.push('### Bundle size (esbuild, minified, browser, es2022)')
  reportLines.push('')
  reportLines.push(...renderBundles(bundleReport.bundles))
}
if (skipped.length > 0) {
  reportLines.push('')
  reportLines.push('Skipped in this run:')
  for (const s of skipped) reportLines.push(`- ${s}`)
}

const report = reportLines.join('\n')
console.log('--- markdown report ---\n')
console.log(report)

// --- artifacts ---------------------------------------------------------------

mkdirSync(resolve(benchDir, 'results'), { recursive: true })
const json = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  cpu: cpus()[0]?.model ?? 'unknown',
  args,
  contestants: contestants.map((c) => ({ name: c.name, tier: c.tier, version: c.version, repo: c.repo, note: c.note })),
  fixtures: fixtures.map((f) => ({ name: f.name, chars: f.text.length, updates: chunksOf(f.text).length })),
  results: Object.fromEntries([...results].map(([f, m]) => [f, Object.fromEntries(m)])),
  bundles: bundleReport.bundles,
  skipped,
}
writeFileSync(resolve(benchDir, 'results/latest.json'), JSON.stringify(json, null, 2) + '\n')
writeFileSync(resolve(benchDir, 'results/latest.md'), report + '\n')
console.log('\nwrote results/latest.json and results/latest.md')

if (args.updateDocs) {
  const docsPath = resolve(repoRoot, 'docs/BENCHMARKS.md')
  const begin = '<!-- bench-results:begin (generated by bench/competitors — do not edit by hand) -->'
  const end = '<!-- bench-results:end -->'
  const doc = readFileSync(docsPath, 'utf8')
  const beginIdx = doc.indexOf(begin)
  const endIdx = doc.indexOf(end)
  if (beginIdx === -1 || endIdx === -1) {
    console.error(`update-docs: markers not found in ${docsPath}`)
    process.exit(1)
  }
  writeFileSync(docsPath, doc.slice(0, beginIdx + begin.length) + '\n\n' + report + '\n\n' + doc.slice(endIdx))
  console.log(`updated ${docsPath}`)
}
