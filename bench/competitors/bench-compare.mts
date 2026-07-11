/**
 * Cross-library streaming benchmark (#157) — non-gating, published out-of-band.
 *
 * Streams a shared corpus chunk-by-chunk through this library and each
 * competitor (Streamdown, react-markdown ± block memoization, smd, Incremark)
 * and reports wall-clock totals, per-chunk latency percentiles, throughput,
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
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { CORPUS_DIR, INCREMARK_CORPUS } from './fetch-corpus.mts'

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

/** Code-block-heavy case (#155): fences dominate, streamed token-by-token. */
function codeHeavyFixture(): string {
  const tsFence = Array.from(
    { length: 70 },
    (_, i) => `export const value${String(i)} = compute(${String(i)}) && registry.get('key-${String(i)}') // trailing note ${String(i)}`,
  ).join('\n')
  const pyFence = Array.from(
    { length: 60 },
    (_, i) => `def handler_${String(i)}(payload):\n    return transform(payload, retries=${String(i % 5)})`,
  ).join('\n\n')
  const jsonFence = JSON.stringify(
    Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`option_${String(i)}`, { enabled: i % 2 === 0, weight: i }])),
    null,
    2,
  )
  return [
    '# Code review notes\n\nThe TypeScript entry point:\n',
    '```ts\n' + tsFence + '\n```\n',
    'And the equivalent Python handlers:\n',
    '```python\n' + pyFence + '\n```\n',
    'With the generated configuration:\n',
    '```json\n' + jsonFence + '\n```\n',
    'Closing prose with **emphasis**, `inline code` and a [link](https://example.com).\n',
  ].join('\n')
}

interface Fixture {
  name: string
  text: string
}

function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = []
  for (const { name } of INCREMARK_CORPUS) {
    const path = resolve(CORPUS_DIR, name)
    if (existsSync(path)) fixtures.push({ name: `incremark/${name}`, text: readFileSync(path, 'utf8') })
    else console.error(`warning: corpus/${name} missing (run fetch-corpus) — fixture skipped`)
  }
  const repoDocs = ['README.md', 'CHANGELOG.md', 'docs/ARCHITECTURE.md', 'tests/fixtures/terms-of-service-streaming.md']
  for (const rel of repoDocs) {
    fixtures.push({ name: rel, text: readFileSync(resolve(repoRoot, rel), 'utf8') })
  }
  fixtures.push({ name: 'synthetic/code-heavy (#155)', text: codeHeavyFixture() })
  fixtures.push({
    name: 'synthetic/long-transcript',
    text: fixtures.map((f) => f.text).join('\n\n---\n\n'),
  })
  return args.fixture ? fixtures.filter((f) => args.fixture?.test(f.name)) : fixtures
}

function chunksOf(text: string): string[] {
  const size = args.parity ? args.chunk : Math.max(args.chunk, Math.ceil(text.length / args.maxUpdates))
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

// ---------------------------------------------------------------------------
// Contestants
// ---------------------------------------------------------------------------

interface RunHandle {
  /** Called once per streamed chunk. `acc` is the full accumulated text. */
  feed: (chunk: string, acc: string) => void
  /** Called once after the last chunk (finalize/flush). Timed. */
  finish?: (acc: string) => void
  /** Untimed cleanup. */
  teardown?: () => void
}

interface Contestant {
  name: string
  tier: 'pipeline' | 'dom'
  version: string
  note?: string
  setup: () => RunHandle
}

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
    tier: 'pipeline',
    version: ourVersion,
    note: 'full re-render per chunk → unsanitized HTML string',
    setup: () => ({ feed: (_c, acc) => void ours.renderMarkdownUnsafe(acc) }),
  })
  contestants.push({
    name: 'ours renderStreamingMarkdown',
    tier: 'pipeline',
    version: ourVersion,
    note: 'full re-render per chunk → SANITIZED HTML string (does strictly more work than any parse-only competitor)',
    setup: () => ({ feed: (_c, acc) => void ours.renderStreamingMarkdown(acc) }),
  })

  try {
    const { createIncremarkParser } = await import('@incremark/core')
    contestants.push({
      name: 'incremark core.append',
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
    tier: 'dom',
    version: ourVersion,
    note: 'StreamingMarkdownRenderer.update — incremental, sanitized',
    setup: () => {
      const { host, teardown } = domHost()
      const renderer = new ours.StreamingMarkdownRenderer(host)
      return { feed: (_c, acc) => renderer.update(acc), teardown }
    },
  })
  contestants.push({
    name: 'ours string→innerHTML',
    tier: 'dom',
    version: ourVersion,
    note: 'full sanitized re-render + innerHTML swap per chunk',
    setup: () => {
      const { host, teardown } = domHost()
      return {
        feed: (_c, acc) => {
          host.innerHTML = ours.renderStreamingMarkdown(acc)
        },
        teardown,
      }
    },
  })

  try {
    const smd = await import('streaming-markdown')
    contestants.push({
      name: 'smd (streaming-markdown)',
      tier: 'dom',
      version: pkgVersion('streaming-markdown'),
      note: 'incremental DOM writer; no sanitizer',
      setup: () => {
        const { host, teardown } = domHost()
        const parser = smd.parser(smd.default_renderer(host))
        return {
          feed: (chunk) => smd.parser_write(parser, chunk),
          finish: () => smd.parser_end(parser),
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
      teardown: () => {
        root.unmount()
        teardown()
      },
    }
  }

  if (reactTools) {
    const rt = reactTools
    try {
      const Markdown = (await import('react-markdown')).default
      contestants.push({
        name: 'react-markdown',
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
        tier: 'dom',
        version: pkgVersion('streamdown'),
        note: 'defaults (internal block memo, hardening, incomplete-markdown repair)',
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
// Bundle size
// ---------------------------------------------------------------------------

interface BundleResult {
  name: string
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
  const entries: { name: string; contents: string; external: string[]; note: string }[] = [
    {
      name: 'ours (DOM + string core)',
      contents: "export { StreamingMarkdownRenderer, renderStreamingMarkdown } from '../../src/index.ts'",
      external: ['dompurify', 'entities', 'highlight.js', 'shiki', 'katex', 'mermaid'],
      note: 'optional peers external (native Sanitizer path)',
    },
    {
      name: 'smd (streaming-markdown)',
      contents: "export * from 'streaming-markdown'",
      external: [],
      note: 'dependency-free',
    },
    {
      name: 'react-markdown',
      contents: "export { default } from 'react-markdown'",
      external: REACT_EXTERNALS,
      note: 'React runtime external (peer)',
    },
    {
      name: 'streamdown',
      contents: "export { Streamdown } from 'streamdown'",
      external: REACT_EXTERNALS,
      note: 'React runtime external (peer); lazy chunks = mermaid etc.',
    },
    {
      name: 'incremark (@incremark/core)',
      contents: "export { createIncremarkParser } from '@incremark/core'",
      external: [],
      note: 'parser only — no renderer',
    },
    {
      name: 'incremark (@incremark/react)',
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
  const header = ['fixture', 'chars', 'updates', ...libs.map((c) => c.name)]
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
    lines.push(`| ${c.name} | ${ms(r.meanMs)} ms | ${ms(r.p50Ms)} ms | ${ms(r.p95Ms)} ms | ${ms(r.maxMs)} ms |`)
  }
  return lines
}

function renderBundles(bundles: BundleResult[]): string[] {
  const lines: string[] = []
  lines.push('| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |')
  lines.push('| :-- | --: | --: | --: | --: | :-- |')
  for (const b of bundles) {
    lines.push(
      `| ${b.name} | ${kb(b.entryMinBytes)} | ${kb(b.entryGzBytes)} | ${kb(b.totalMinBytes)} | ${kb(b.totalGzBytes)} | ${b.note} |`,
    )
  }
  return lines
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const fixtures = loadFixtures()
const { contestants, skipped } = await buildContestants()

function measureFixture(
  fixture: Fixture,
  into: Map<string, Map<string, RunStats | { error: string }>>,
): void {
  const chunks = chunksOf(fixture.text)
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
      console.log(
        `  ${contestant.name.padEnd(34)} [${contestant.tier.padEnd(8)}] total ${ms(stats.totalMs).padStart(8)} ms  ` +
          `p50 ${ms(stats.p50Ms).padStart(7)}  p95 ${ms(stats.p95Ms).padStart(7)}  max ${ms(stats.maxMs).padStart(7)}  ` +
          `${(stats.charsPerSec / 1000).toFixed(0).padStart(6)}k chars/s`,
      )
    }
  }
  console.log()
}

// Child mode: measure the (already --fixture-filtered) fixtures in THIS
// process and emit raw results as JSON for the parent. Exists because
// DOMPurify's string path retains ~1-2 MB per sanitize under jsdom (surviving
// GC and even window teardown — an upstream jsdom retention, not present in
// real browsers), so a whole-corpus run in one process eventually OOMs no
// matter the heap. One process per fixture caps the damage and also means a
// competitor crash only loses that fixture.
if (args.childOut) {
  const childResults = new Map<string, Map<string, RunStats | { error: string }>>()
  for (const fixture of fixtures) measureFixture(fixture, childResults)
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
    const partial = resolve(benchDir, `results/.partial-${String(i)}.json`)
    const child = spawnSync(
      process.execPath,
      [
        tsxCli,
        script,
        '--fixture',
        `^${escapeRegExp(fixture.name)}$`,
        '--child-out',
        partial,
        ...['--iters', String(args.iters), '--warmup', String(args.warmup), '--chunk', String(args.chunk)],
        ...['--max-updates', String(args.maxUpdates)],
        ...(args.parity ? ['--parity'] : []),
        ...(args.only ? ['--only', args.only.source] : []),
      ],
      { stdio: ['ignore', 'inherit', 'inherit'], cwd: benchDir },
    )
    if (child.status === 0 && existsSync(partial)) {
      const partialJson = JSON.parse(readFileSync(partial, 'utf8')) as {
        results: Record<string, Record<string, RunStats | { error: string }>>
        skipped: string[]
      }
      for (const [name, perLib] of Object.entries(partialJson.results)) {
        results.set(name, new Map(Object.entries(perLib)))
      }
      skipped.push(...partialJson.skipped)
      rmSync(partial, { force: true })
    } else {
      console.error(`fixture ${fixture.name}: child exited ${String(child.status)} — recorded as skipped`)
      skipped.push(`${fixture.name}: fixture child process exited ${String(child.status)} (crash/OOM)`)
      results.set(fixture.name, new Map(contestants.map((c) => [c.name, { error: 'fixture child crashed' }])))
    }
  }
} else {
  for (const fixture of fixtures) measureFixture(fixture, results)
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
  contestants: contestants.map((c) => ({ name: c.name, tier: c.tier, version: c.version, note: c.note })),
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
