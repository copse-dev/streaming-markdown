/**
 * Real-browser (Chromium) streaming tier of the cross-library benchmark —
 * ADR 0004 Phase 0's decision input. The jsdom tier (`bench-compare.mts`)
 * measures JS + DOM-tree work only; this runner replays the SAME corpus with
 * the SAME chunking inside a real engine, forcing a synchronous layout flush
 * after every update (`offsetHeight` read), so per-update numbers include
 * style recalc + layout — the costs the ADR needs sized before funding the
 * sealed-block emitter (paint/raster still excluded; they happen off the
 * update's critical path).
 *
 * Contestants are the direct-DOM libraries the architectural question is
 * about: our incremental renderer (sanitized, unsafe, and smd-parity
 * configurations) and smd. React competitors are deliberately out of scope
 * here — their jsdom ranking is not layout-bound in a way that changes the
 * ADR decision, and bundling them into a page harness adds noise, not signal.
 *
 * Run from bench/competitors: `npm run bench:browser` (fetches the corpus
 * first). Requires playwright-core (repo-root devDependency) and a Chromium
 * binary (CHROMIUM_BIN, PLAYWRIGHT_BROWSERS_PATH, or PATH). Our sanitized row
 * uses the native Sanitizer (`Element.setHTML`) when this Chromium ships it,
 * else the bundled DOMPurify backend — the header line says which ran.
 *
 * Flags: --fixture REGEX --only REGEX --iters N (3) --warmup N (1)
 *        --chunk N (5) --max-updates N (200) --parity
 *        --update-docs (rewrites the browser-results section of docs/BENCHMARKS.md)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'
import { findChromium, hasPlaywright } from '../../tests/tt-browser-harness.ts'
import { chunksOf, loadFixtures, type ChunkOptions } from './fixtures.mts'

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)))

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args extends ChunkOptions {
  iters: number
  warmup: number
  fixture: RegExp | null
  only: RegExp | null
  updateDocs: boolean
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
    updateDocs: false,
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
    else if (flag === '--update-docs') args.updateDocs = true
    else if (flag !== undefined) {
      console.error(`unknown flag: ${flag}`)
      process.exit(2)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

// ---------------------------------------------------------------------------
// Page bundle: our library + smd + the DOMPurify fallback backend, exposed as
// window.BENCH for the in-page driver.
// ---------------------------------------------------------------------------

async function buildPageBundle(): Promise<string> {
  const esbuild = await import('esbuild')
  const entry = `
    import * as OURS from '../../src/index.ts'
    import { dompurifyBackend } from '../../src/sanitize-dompurify.ts'
    import * as SMD from 'streaming-markdown'
    ;(window as never as { BENCH: unknown }).BENCH = { OURS, SMD, dompurifyBackend }
  `
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: benchDir, loader: 'ts', sourcefile: 'browser-entry.ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  })
  const file = result.outputFiles?.[0]
  if (!file) throw new Error('esbuild produced no output for the page bundle')
  return file.text
}

// ---------------------------------------------------------------------------
// In-page driver — serialized into the page by Playwright. One call replays
// one (contestant × fixture) run and returns per-update durations in ms.
// ---------------------------------------------------------------------------

interface DriverInput {
  contestant: string
  chunks: string[]
}

// Typed mirror of what the bundle exposes; evaluated inside the page.
const runInPage = (input: DriverInput): { durations: number[]; sanitizer: string } => {
  interface BenchGlobals {
    OURS: typeof import('../../src/index.ts')
    SMD: {
      parser: (r: unknown) => unknown
      default_renderer: (el: Element) => unknown
      parser_write: (p: unknown, chunk: string) => void
      parser_end: (p: unknown) => void
    }
    dompurifyBackend: import('../../src/sanitize.ts').SanitizerBackend
  }
  const { OURS, SMD, dompurifyBackend } = (window as never as { BENCH: BenchGlobals }).BENCH
  const passthrough: import('../../src/sanitize.ts').SanitizerBackend = {
    sanitize: (html) => html,
  }
  const nativeSanitizer = typeof Element.prototype.setHTML === 'function'

  const host = document.getElementById('host')
  if (!host) throw new Error('no #host')
  host.textContent = ''
  const mount = document.createElement('div')
  host.append(mount)

  let feed: (chunk: string, acc: string) => void
  let finish: (() => void) | undefined
  let sanitizer = 'n/a'
  if (input.contestant === 'smd (streaming-markdown)') {
    const parser = SMD.parser(SMD.default_renderer(mount))
    feed = (chunk) => {
      SMD.parser_write(parser, chunk)
    }
    finish = () => {
      SMD.parser_end(parser)
    }
  } else {
    let config: import('../../src/index.ts').MarkdownConfig
    if (input.contestant === 'ours DOM incremental') {
      config = nativeSanitizer ? {} : { sanitizerBackend: dompurifyBackend }
      sanitizer = nativeSanitizer ? 'native Sanitizer (Element.setHTML)' : 'DOMPurify backend'
    } else if (input.contestant === 'ours DOM incremental (unsafe)') {
      config = { sanitizerBackend: passthrough }
      sanitizer = 'passthrough'
    } else if (input.contestant === 'ours DOM incremental (smd parity)') {
      config = {
        sanitizerBackend: passthrough,
        htmlPolicy: 'escape',
        emailAutolinks: false,
        footnotes: false,
        linkReferences: false,
      }
      sanitizer = 'passthrough'
    } else {
      throw new Error(`unknown contestant ${input.contestant}`)
    }
    const renderer = new OURS.StreamingMarkdownRenderer(mount, config)
    feed = (_chunk, acc) => {
      renderer.update(acc)
    }
  }

  const durations: number[] = []
  let acc = ''
  for (const chunk of input.chunks) {
    acc += chunk
    const start = performance.now()
    feed(chunk, acc)
    // Force style recalc + layout into the timed window — the cost jsdom
    // cannot see. Paint/raster still happen after the frame and are excluded.
    void mount.offsetHeight
    durations.push(performance.now() - start)
  }
  if (finish) {
    const start = performance.now()
    finish()
    void mount.offsetHeight
    durations.push(performance.now() - start)
  }
  mount.remove()
  return { durations, sanitizer }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const CONTESTANTS = [
  'ours DOM incremental',
  'ours DOM incremental (unsafe)',
  'ours DOM incremental (smd parity)',
  'smd (streaming-markdown)',
].filter((name) => !args.only || args.only.test(name))

interface RunStats {
  totalMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

function statsOf(durations: number[]): RunStats {
  const sorted = [...durations].sort((a, b) => a - b)
  const pick = (p: number): number =>
    sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0
  return {
    totalMs: durations.reduce((a, x) => a + x, 0),
    p50Ms: pick(50),
    p95Ms: pick(95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  }
}

const ms = (v: number): string => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2))

async function main(): Promise<void> {
  if (!hasPlaywright()) {
    console.error('bench:browser requires playwright-core (repo-root devDependency; run npm ci at the root)')
    process.exit(1)
  }
  const chromiumPath = findChromium()
  if (!chromiumPath) {
    console.error('no Chromium found (set CHROMIUM_BIN or PLAYWRIGHT_BROWSERS_PATH)')
    process.exit(1)
  }

  const fixtures = loadFixtures(args.fixture)
  const bundle = await buildPageBundle()
  const { chromium } = (await import('playwright-core')) as typeof import('playwright-core')
  const browser = await chromium.launch({ executablePath: chromiumPath })
  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><body><div id="host"></div></body></html>')
  // tsx transpiles this file with esbuild's keepNames helper, so the
  // Playwright-serialized in-page driver references `__name`; shim it.
  await page.addScriptTag({ content: 'globalThis.__name = (fn) => fn' })
  await page.addScriptTag({ content: bundle })

  let sanitizerLine = ''
  const results = new Map<string, Map<string, RunStats>>()
  try {
    for (const fixture of fixtures) {
      const chunks = chunksOf(fixture.text, args)
      const perLib = new Map<string, RunStats>()
      results.set(fixture.name, perLib)
      console.log(`fixture ${fixture.name} — ${String(fixture.text.length)} chars, ${String(chunks.length)} updates`)
      for (const contestant of CONTESTANTS) {
        const runs: { stats: RunStats; sanitizer: string }[] = []
        for (let i = 0; i < args.warmup + args.iters; i++) {
          const out = await page.evaluate(runInPage, { contestant, chunks })
          if (i >= args.warmup) runs.push({ stats: statsOf(out.durations), sanitizer: out.sanitizer })
        }
        runs.sort((a, b) => a.stats.totalMs - b.stats.totalMs)
        const median = runs[Math.floor(runs.length / 2)]
        if (!median) continue
        perLib.set(contestant, median.stats)
        if (contestant === 'ours DOM incremental') sanitizerLine = median.sanitizer
        console.log(
          `  ${contestant.padEnd(36)} total ${ms(median.stats.totalMs).padStart(8)} ms  ` +
            `p50 ${ms(median.stats.p50Ms).padStart(7)}  p95 ${ms(median.stats.p95Ms).padStart(7)}  max ${ms(median.stats.maxMs).padStart(7)}`,
        )
      }
      console.log()
    }
  } finally {
    await browser.close()
  }

  const lines: string[] = []
  lines.push(
    `_Real-browser tier: Chromium via playwright-core, layout forced per update (\`offsetHeight\`), ` +
      `${new Date().toISOString().slice(0, 10)}, node ${process.version}, ${cpus()[0]?.model ?? 'unknown cpu'}, ` +
      `chunk=${String(args.chunk)}${args.parity ? ' (parity, uncapped)' : `, capped at ${String(args.maxUpdates)} updates/fixture`}, ` +
      `median of ${String(args.iters)} runs. Our sanitized row used: ${sanitizerLine || 'n/a'}._`,
  )
  lines.push('')
  lines.push(`| fixture | chars | updates | ${CONTESTANTS.join(' | ')} |`)
  lines.push(`| :-- | --: | --: | ${CONTESTANTS.map(() => '--:').join(' | ')} |`)
  for (const fixture of fixtures) {
    const perLib = results.get(fixture.name)
    if (!perLib) continue
    const updates = chunksOf(fixture.text, args).length
    const cells = CONTESTANTS.map((c) => {
      const r = perLib.get(c)
      return r ? `${ms(r.totalMs)} ms (p95 ${ms(r.p95Ms)})` : '—'
    })
    lines.push(`| ${fixture.name} | ${String(fixture.text.length)} | ${String(updates)} | ${cells.join(' | ')} |`)
  }
  const report = lines.join('\n')
  console.log('--- markdown report ---\n')
  console.log(report)
  mkdirSync(resolve(benchDir, 'results'), { recursive: true })
  writeFileSync(resolve(benchDir, 'results/browser-latest.md'), report + '\n')
  console.log('\nwrote results/browser-latest.md')

  if (args.updateDocs) {
    const docsPath = resolve(benchDir, '../../docs/BENCHMARKS.md')
    const begin = '<!-- bench-browser-results:begin (generated by bench-browser-live — do not edit by hand) -->'
    const end = '<!-- bench-browser-results:end -->'
    const doc = readFileSync(docsPath, 'utf8')
    const beginIdx = doc.indexOf(begin)
    const endIdx = doc.indexOf(end)
    if (beginIdx === -1 || endIdx === -1) {
      console.error(`update-docs: browser-results markers not found in ${docsPath}`)
      process.exit(1)
    }
    writeFileSync(docsPath, doc.slice(0, beginIdx + begin.length) + '\n\n' + report + '\n\n' + doc.slice(endIdx))
    console.log(`updated ${docsPath}`)
  }
}

await main()
