/**
 * Real-browser (Chromium) sink-path benchmark (`npm run bench:browser`).
 *
 * Measures per-write throughput of the three sanitizer sink paths on
 * representative rendered-markdown payloads, in a real engine rather than
 * jsdom:
 *
 *   - string: `el.innerHTML = sanitizeRenderedMarkdown(html)` (pre-TT sink)
 *   - node:   `sanitizeRenderedMarkdownInto(el, html)` (backend node path)
 *   - sink:   `setSanitizedHtml(el, html)` (the shipped chokepoint)
 *
 * A second page runs with Trusted Types ENFORCED
 * (`require-trusted-types-for 'script'`) and re-measures the chokepoint, so a
 * regression in the enforced path shows up as a gap against the open page.
 * The script asserts enforcement is real (a raw innerHTML write must throw)
 * and exits non-zero otherwise.
 *
 * Requires playwright-core (devDependency) and a Chromium binary
 * (CHROMIUM_BIN env var, PLAYWRIGHT_BROWSERS_PATH, or PATH). Numbers are
 * machine-dependent — compare runs on the same machine only.
 */
import {
  findChromium,
  hasPlaywright,
  launchTTBrowser,
  ttCspMeta,
  type PwPage,
} from '../tests/tt-browser-harness.ts'

// Type-only view of the page's SM global (see tests/trusted-types.e2e.test.ts).
type SMApi = typeof import('../src/index.ts') & {
  sanitizeRenderedMarkdownInto: (typeof import('../src/sanitize.ts'))['sanitizeRenderedMarkdownInto']
  setPresanitizedHtml: (typeof import('../src/html-sink.ts'))['setPresanitizedHtml']
  dompurifyBackend: (typeof import('../src/sanitize-dompurify.ts'))['dompurifyBackend']
}
declare const SM: SMApi

const MARKDOWNS: Record<string, string> = {
  'pending-line': 'checking the **bold** tail with `code` and a [link](https://x.dev)',
  'prose+lists': Array.from(
    { length: 12 },
    (_, i) =>
      `## Section ${i}\n\nSome *prose* with \`code\` and **emphasis** in paragraph ${i}.\n\n- item a${i}\n- item b${i}`,
  ).join('\n\n'),
  'code-fence':
    '```ts\n' +
    Array.from({ length: 60 }, (_, i) => `const value${i} = compute(${i}) && flag; // trailing comment ${i}`).join(
      '\n',
    ) +
    '\n```',
  'gfm-table':
    '| col a | col b | col c |\n|---|---|---|\n' +
    Array.from({ length: 30 }, (_, i) => `| **v${i}** | \`c${i}\` | text ${i} |`).join('\n'),
}

interface OpenRow {
  bytes: number
  string: number
  node: number
  sink: number
}

async function benchOpenPage(page: PwPage): Promise<Record<string, OpenRow>> {
  return page.evaluate((markdowns: Record<string, string>) => {
    function bench(fn: () => void): number {
      for (let i = 0; i < 30; i++) fn()
      const runs: number[] = []
      for (let r = 0; r < 5; r++) {
        let ops = 0
        const start = performance.now()
        while (performance.now() - start < 300) {
          fn()
          ops++
        }
        runs.push((ops / (performance.now() - start)) * 1000)
      }
      runs.sort((a, b) => a - b)
      return runs[2] as number
    }
    if (!SM.isBrowserSanitizerSupported()) SM.setSanitizerBackend(SM.dompurifyBackend)
    const el = document.createElement('div')
    document.body.append(el)
    const out: Record<string, OpenRow> = {}
    for (const [name, md] of Object.entries(markdowns)) {
      const html = SM.renderMarkdown(md) as string
      out[name] = {
        bytes: html.length,
        string: bench(() => {
          el.innerHTML = SM.sanitizeRenderedMarkdown(html) as string
        }),
        node: bench(() => {
          SM.sanitizeRenderedMarkdownInto(el, html)
        }),
        sink: bench(() => {
          SM.setSanitizedHtml(el, html)
        }),
      }
    }
    return out
  }, MARKDOWNS)
}

async function benchEnforcedPage(page: PwPage): Promise<{ enforced: boolean; rows: Record<string, number> }> {
  return page.evaluate((markdowns: Record<string, string>) => {
    function bench(fn: () => void): number {
      for (let i = 0; i < 30; i++) fn()
      const runs: number[] = []
      for (let r = 0; r < 5; r++) {
        let ops = 0
        const start = performance.now()
        while (performance.now() - start < 300) {
          fn()
          ops++
        }
        runs.push((ops / (performance.now() - start)) * 1000)
      }
      runs.sort((a, b) => a - b)
      return runs[2] as number
    }
    let enforced = false
    try {
      document.createElement('div').innerHTML = '<p>x</p>'
    } catch {
      enforced = true
    }
    if (!SM.isBrowserSanitizerSupported()) SM.setSanitizerBackend(SM.dompurifyBackend)
    const el = document.createElement('div')
    document.body.append(el)
    const rows: Record<string, number> = {}
    for (const [name, md] of Object.entries(markdowns)) {
      const html = SM.renderMarkdown(md) as string
      rows[name] = bench(() => {
        SM.setSanitizedHtml(el, html)
      })
    }
    return { enforced, rows }
  }, MARKDOWNS)
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width)
}

async function main(): Promise<void> {
  if (!hasPlaywright()) {
    console.error('bench:browser requires playwright-core (npm i -D playwright-core)')
    process.exitCode = 1
    return
  }
  const chromiumPath = findChromium()
  if (!chromiumPath) {
    console.error('bench:browser: no Chromium binary found — set CHROMIUM_BIN')
    process.exitCode = 1
    return
  }

  const browser = await launchTTBrowser(chromiumPath)
  try {
    const openPage = await browser.newBundlePage(null)
    const open = await benchOpenPage(openPage)
    const backend = await openPage.evaluate(
      () => (SM.isBrowserSanitizerSupported() ? 'native setHTML' : 'dompurify'),
      null,
    )
    const enforcedPage = await browser.newBundlePage(ttCspMeta('streaming-markdown dompurify'))
    const enforced = await benchEnforcedPage(enforcedPage)

    console.log(`browser sink bench — Chromium (${chromiumPath}), backend: ${backend}`)
    console.log('ops/sec, median of 5 x 300ms windows; higher is better\n')
    console.log('payload'.padEnd(16), pad('bytes', 6), pad('string', 9), pad('node', 9), pad('node/str', 9), pad('sink', 9), pad('sink+TT', 9))
    for (const name of Object.keys(MARKDOWNS)) {
      const row = open[name]
      if (!row) continue
      const tt = enforced.rows[name] ?? 0
      console.log(
        name.padEnd(16),
        pad(row.bytes, 6),
        pad(row.string.toFixed(0), 9),
        pad(row.node.toFixed(0), 9),
        pad(`${(row.node / row.string).toFixed(2)}x`, 9),
        pad(row.sink.toFixed(0), 9),
        pad(tt.toFixed(0), 9),
      )
    }
    if (!enforced.enforced) {
      console.error('\nFAIL: the Trusted Types page was not actually enforcing (plain innerHTML did not throw)')
      process.exitCode = 1
    } else {
      console.log('\nTrusted Types page: enforcement verified (plain innerHTML write throws); sink+TT column ran under it.')
    }
  } finally {
    await browser.close()
  }
}

await main()
