/**
 * Trusted Types end-to-end suite (`npm run test:e2e`).
 *
 * Runs the shipped bundle in a real Chromium page under an ENFORCED
 * `Content-Security-Policy: require-trusted-types-for 'script'` — something
 * jsdom cannot simulate — and asserts the invariants the Trusted Types work
 * promises:
 *
 *   1. the CSP is genuinely enforcing (a raw string innerHTML write throws);
 *   2. the streaming DOM emitter renders correctly under enforcement and
 *      converges with the sanitized at-rest render;
 *   3. the innerHTML string path (a backend without `sanitizeInto`, e.g. a
 *      custom DOMPurify wrapper) works via the default policy;
 *   4. mermaid hydration accepts a host-minted TrustedHTML from transformSvg
 *      and fails closed (--error, no injection) for plain-string SVG;
 *   5. a CSP that omits DOMPurify's own 'dompurify' policy degrades to empty
 *      output without crashing (DOMPurify cannot parse at all there).
 *
 * Skips (rather than fails) when playwright-core or a Chromium binary is
 * unavailable, so the main jsdom suite stays runnable everywhere.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findChromium,
  hasPlaywright,
  launchTTBrowser,
  ttCspMeta,
  type PwPage,
  type TTBrowser,
} from './tt-browser-harness.ts'

// The SM global is installed in the PAGE by the harness bundle; this
// type-only declaration types the code inside page.evaluate callbacks (the
// callbacks are serialized — SM resolves to the page global at runtime).
type SMApi = typeof import('../src/index.ts') & {
  sanitizeRenderedMarkdownInto: (typeof import('../src/sanitize.ts'))['sanitizeRenderedMarkdownInto']
  setPresanitizedHtml: (typeof import('../src/html-sink.ts'))['setPresanitizedHtml']
  dompurifyBackend: (typeof import('../src/sanitize-dompurify.ts'))['dompurifyBackend']
  // Internal sanitizer registration exposed by the harness bundle (no longer on
  // the public API — the sink helper reads the process-wide backend).
  setSanitizerBackend: (typeof import('../src/sanitize.ts'))['setSanitizerBackend']
}
declare const SM: SMApi

const chromiumPath = findChromium()
const skip = !hasPlaywright()
  ? 'playwright-core is not installed'
  : !chromiumPath
    ? 'no Chromium binary found (set CHROMIUM_BIN)'
    : false

// In CI the browser is guaranteed present (the workflow installs the
// playwright-core-matched Chromium), so a skip there means the five assertions
// silently never ran. `E2E_REQUIRE_BROWSER=1` promotes that skip to a hard
// failure, making the "assertions actually executed" guarantee explicit and
// independent of the install step happening to fail first.
if (skip && process.env['E2E_REQUIRE_BROWSER']) {
  throw new Error(
    `E2E_REQUIRE_BROWSER is set but the Trusted Types e2e suite would skip: ${skip}`,
  )
}

describe('Trusted Types enforcement e2e (real Chromium)', { skip }, () => {
  let browser: TTBrowser
  let page: PwPage

  before(async () => {
    browser = await launchTTBrowser(chromiumPath as string)
    page = await browser.newBundlePage(ttCspMeta('streaming-markdown dompurify mermaid-svg'))
  })
  after(async () => {
    await browser?.close()
  })

  it('the page CSP genuinely enforces Trusted Types', async () => {
    const result = await page.evaluate(() => {
      try {
        document.createElement('div').innerHTML = '<p>x</p>'
        return 'no throw'
      } catch (e) {
        return (e as Error).constructor.name
      }
    }, null)
    assert.equal(result, 'TypeError', 'plain-string innerHTML must be rejected')
  })

  it('streaming DOM emitter renders and converges under enforcement', async () => {
    const result = await page.evaluate(() => {
      SM.setSanitizerBackend(SM.dompurifyBackend)
      const md =
        '# Title\n\nsome **bold** text with `code`\n\n- item one\n- item two\n\n' +
        '| a | b |\n|---|---|\n| **1** | 2 |\n\n```ts\nconst x = 1\n```\n'
      const host = document.createElement('div')
      document.body.append(host)
      const r = new SM.StreamingMarkdownRenderer(host)
      // Stream in uneven chunks so pending/forming sinks are exercised too.
      for (let i = 1; i <= md.length; i += 7) r.update(md.slice(0, i))
      r.update(md)
      const complete = host.querySelector('.stream-complete')
      return {
        streamed: complete?.innerHTML ?? '',
        atRest: (() => {
          const el = document.createElement('div')
          SM.setSanitizedHtml(el, SM.renderMarkdownUnsafe(md))
          return el.innerHTML
        })(),
      }
    }, null)
    assert.ok(/<h1>Title<\/h1>/.test(result.streamed), 'heading rendered')
    assert.ok(/<strong>bold<\/strong>/.test(result.streamed), 'inline emphasis rendered')
    assert.ok(/<table>/.test(result.streamed), 'table rendered')
    assert.equal(result.streamed, result.atRest, 'streamed output converges with at-rest render')
  })

  it('string innerHTML path (backend without sanitizeInto) works via the default policy', async () => {
    const result = await page.evaluate(() => {
      const inner = SM.dompurifyBackend
      SM.setSanitizerBackend({
        sanitize: (h: string, c: Parameters<SMApi['dompurifyBackend']['sanitize']>[1]) =>
          inner.sanitize(h, c),
      })
      const el = document.createElement('div')
      document.body.append(el)
      SM.setSanitizedHtml(el, '<p>string path <strong>under TT</strong></p><script>x()<\/script>')
      const html = el.innerHTML
      SM.setSanitizerBackend(SM.dompurifyBackend)
      return html
    }, null)
    assert.equal(result, '<p>string path <strong>under TT</strong></p>')
  })

  it('mermaid hydration accepts host TrustedHTML and fails closed on plain strings', async () => {
    const result = await page.evaluate(async () => {
      SM.setSanitizerBackend(SM.dompurifyBackend)
      const diagramRenderer = {
        render: () => Promise.resolve({ svg: '<svg data-diagram="ok"><g></g></svg>' }),
      }
      const host = document.createElement('div')
      document.body.append(host)
      SM.setSanitizedHtml(host, SM.renderMarkdownUnsafe('```mermaid\ngraph TD\nA --> B\n```'))

      // Plain-string SVG: the injection sink rejects it; the diagram must fail
      // closed (marked --error, nothing injected) rather than crash.
      const plainCount = await SM.hydratePendingDiagrams(host, { renderer: diagramRenderer })
      const failedClosed =
        plainCount === 0 &&
        host.querySelector('.mermaid-diagram--error') !== null &&
        host.querySelector('svg') === null

      // Host-minted TrustedHTML via transformSvg: renders.
      const host2 = document.createElement('div')
      document.body.append(host2)
      SM.setSanitizedHtml(host2, SM.renderMarkdownUnsafe('```mermaid\ngraph TD\nA --> B\n```'))
      const policy = (
        window as unknown as {
          trustedTypes: {
            createPolicy(
              n: string,
              r: object,
            ): { createHTML(s: string): { toString(): string } }
          }
        }
      ).trustedTypes.createPolicy('mermaid-svg', { createHTML: (s: string) => s })
      const trustedCount = await SM.hydratePendingDiagrams(host2, {
        renderer: diagramRenderer,
        transformSvg: (svg: string) => policy.createHTML(svg),
      })
      const rendered =
        trustedCount === 1 &&
        host2.querySelector('.mermaid-diagram--rendered svg[data-diagram="ok"]') !== null
      return { failedClosed, rendered }
    }, null)
    assert.ok(result.failedClosed, 'plain-string SVG fails closed under enforcement')
    assert.ok(result.rendered, 'TrustedHTML SVG from transformSvg is injected')
  })

  it('CSP without the dompurify policy degrades to empty output, not a crash', async () => {
    const strictPage = await browser.newBundlePage(ttCspMeta('streaming-markdown'))
    const result = await strictPage.evaluate(() => {
      SM.setSanitizerBackend(SM.dompurifyBackend)
      const el = document.createElement('div')
      el.append(document.createElement('p'))
      document.body.append(el)
      try {
        SM.setSanitizedHtml(el, '<p>content</p>')
        return { threw: false, html: el.innerHTML }
      } catch (e) {
        return { threw: true, html: String(e) }
      }
    }, null)
    await strictPage.close()
    assert.equal(result.threw, false, 'must not crash when DOMPurify cannot parse')
    assert.equal(result.html, '', 'renders empty (DOMPurify string path parity)')
  })
})
