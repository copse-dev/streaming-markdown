// Named access on window/document is browser behavior: exercise live mounts,
// both bundled sanitizers, and both string and streaming DOM sinks.
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findChromium, hasPlaywright, launchTTBrowser, type TTBrowser } from './tt-browser-harness.ts'

type SMApi = typeof import('../src/index.ts') & {
  dompurifyBackend: (typeof import('../src/sanitize-dompurify.ts'))['dompurifyBackend']
}
declare const SM: SMApi

const chromiumPath = findChromium()
const skip = !hasPlaywright() ? 'playwright-core unavailable' : !chromiumPath ? 'Chromium unavailable' : false
if (skip && process.env['E2E_REQUIRE_BROWSER']) throw new Error(skip)

describe('DOM clobbering boundaries (real Chromium)', { skip }, () => {
  let browser: TTBrowser
  before(async () => { browser = await launchTTBrowser(chromiumPath as string) })
  after(async () => { await browser?.close() })

  for (const backend of ['dompurify', 'native'] as const) {
    it(`${backend}: strips arbitrary names at rest and at every streaming prefix`, async () => {
      const page = await browser.newBundlePage(null)
      try {
        const result = await page.evaluate((backend) => {
          if (backend === 'native' && !SM.isBrowserSanitizerSupported()) {
            throw new Error('Native Sanitizer API unavailable; this check requires a supporting Chromium')
          }
          const sanitizerBackend = backend === 'native' ? SM.browserSanitizerBackend : SM.dompurifyBackend
          const config = { sanitizerBackend }
          const source = '<a id="smClobberConfig" name="smClobberConfig" href="https://attacker.invalid/">x</a>' +
            '<form id="forms"><input name="getElementById"></form>' +
            '<input type="checkbox" name="smClobberConfig">\n\n'
          const host = document.createElement('div')
          document.body.append(host)
          const globals = window as unknown as Record<string, unknown>
          const getElementById = document.getElementById
          const forms = document.forms
          const safe = () => !host.querySelector('[id], [name], form') &&
            globals['smClobberConfig'] === undefined &&
            document.getElementById === getElementById && document.forms === forms
          host.innerHTML = SM.renderMarkdown(source, config)
          const atRest = safe()
          const renderer = new SM.StreamingMarkdownRenderer(host, config)
          let streaming = true
          for (let i = 1; i <= source.length; i++) {
            renderer.update(source.slice(0, i))
            streaming = streaming && safe()
          }
          renderer.finish()
          return { atRest, streaming: streaming && safe() }
        }, backend)
        assert.deepEqual(result, { atRest: true, streaming: true })
      } finally { await page.close() }
    })

    it(`${backend}: isolates raw IDs and preserves footnote links across both sinks`, async () => {
      const page = await browser.newBundlePage(null)
      try {
        const result = await page.evaluate((backend) => {
          const sanitizerBackend = backend === 'native' ? SM.browserSanitizerBackend : SM.dompurifyBackend
          const config = { sanitizerBackend, footnoteIdPrefix: 'message-7-' }
          const source = '<a id="fn-clobber-probe" href="https://attacker.invalid/">forged</a>\n\n' +
            'Note[^n] again[^n]\n\n[^n]: real note'
          const host = document.createElement('div')
          document.body.append(host)
          const globals = window as unknown as Record<string, unknown>
          const atRest = SM.renderMarkdown(source, config)
          host.innerHTML = atRest
          const checkLinks = () => {
            const links = Array.from(host.querySelectorAll('.footnote-ref > a, a.footnote-backref'))
            return links.length === 3 && links.every((link) => {
              const href = link.getAttribute('href') ?? ''
              const target = document.getElementById(href.slice(1))
              const describedBy = link.getAttribute('aria-describedby')
              return href.startsWith('#user-content-') && target !== null && host.contains(target) &&
                (!describedBy || document.getElementById(describedBy)?.textContent === 'Footnotes')
            })
          }
          const atRestLinks = checkLinks()
          const renderer = new SM.StreamingMarkdownRenderer(host, config)
          let isolated = true
          for (let i = 1; i <= source.length; i++) {
            renderer.update(source.slice(0, i))
            isolated = isolated && Array.from(host.querySelectorAll('[id]')).every(
              (node) => node.id.startsWith('user-content-'),
            ) && globals['fn-clobber-probe'] === undefined
          }
          renderer.finish()
          return {
            atRestLinks, streamedLinks: checkLinks(), isolated,
            converged: host.querySelector('.stream-complete')?.innerHTML === atRest,
            originalNamesAbsent: globals['fn-clobber-probe'] === undefined &&
              globals['fn-message-7-n'] === undefined && globals['message-7-footnote-label'] === undefined,
          }
        }, backend)
        assert.deepEqual(result, {
          atRestLinks: true, streamedLinks: true, isolated: true, converged: true, originalNamesAbsent: true,
        })
      } finally { await page.close() }
    })

    it(`${backend}: strips image names even when a host allowlists them`, async () => {
      const page = await browser.newBundlePage(null)
      try {
        const result = await page.evaluate((backend) => {
          const sanitizerBackend = backend === 'native' ? SM.browserSanitizerBackend : SM.dompurifyBackend
          const host = document.createElement('div')
          document.body.append(host)
          host.innerHTML = SM.renderMarkdown('<img name="smClobberConfig">', {
            sanitizerBackend, sanitizeExtension: { allowedTags: ['img'], allowedAttr: ['name'] },
          })
          const globals = window as unknown as Record<string, unknown>
          return host.querySelector('img') !== null && !host.querySelector('[name]') &&
            globals['smClobberConfig'] === undefined &&
            (document as unknown as Record<string, unknown>)['smClobberConfig'] === undefined
        }, backend)
        assert.equal(result, true)
      } finally { await page.close() }
    })

    it(`${backend}: keeps isolation idempotent and rewrites encoded fragments and ARIA lists`, async () => {
      const page = await browser.newBundlePage(null)
      try {
        const result = await page.evaluate((backend) => {
          SM.setDefaultConfig({
            sanitizerBackend: backend === 'native' ? SM.browserSanitizerBackend : SM.dompurifyBackend,
            sanitizeExtension: { allowedAttr: ['aria-labelledby', 'name'] },
          })
          const source = '<h2 id="footnote-label">Footnotes</h2><li id="fn-note">note</li>' +
            '<a id="fnref-note" href="#fn%2Dnote" aria-describedby="footnote-label  fn-note" ' +
            'aria-labelledby="fn-note">ref</a>' +
            '<input type="checkbox" id="fn-checkbox" name="smClobberConfig">' +
            '<a href="#fn%ZZ">malformed fragment</a>'
          const once = SM.sanitizeRenderedMarkdown(source)
          const host = document.createElement('div')
          SM.setSanitizedHtml(host, source)
          const ref = host.querySelector('a')
          return {
            idempotent: SM.sanitizeRenderedMarkdown(once) === once,
            nodeMatchesString: host.innerHTML === once,
            href: ref?.getAttribute('href'),
            describedBy: ref?.getAttribute('aria-describedby'),
            labelledBy: ref?.getAttribute('aria-labelledby'),
            checkboxId: host.querySelector('input')?.id,
            noNames: host.querySelector('[name]') === null,
            malformedPreserved: host.querySelector('a:last-child')?.getAttribute('href') === '#fn%ZZ',
          }
        }, backend)
        assert.deepEqual(result, {
          idempotent: true, nodeMatchesString: true, href: '#user-content-fn-note',
          describedBy: 'user-content-footnote-label  user-content-fn-note',
          labelledBy: 'user-content-fn-note', checkboxId: 'user-content-fn-checkbox',
          noNames: true, malformedPreserved: true,
        })
      } finally { await page.close() }
    })

    it(`${backend}: isolates IDs and names added by the host element hook`, async () => {
      const page = await browser.newBundlePage(null)
      try {
        const result = await page.evaluate((backend) => {
          const html = SM.renderMarkdown('<span>host metadata</span>', {
            sanitizerBackend: backend === 'native' ? SM.browserSanitizerBackend : SM.dompurifyBackend,
            sanitizeExtension: {
              allowedAttr: ['name'],
              onElement(node, tag) {
                if (tag !== 'span') return
                node.setAttribute('id', 'fn-host')
                node.setAttribute('name', 'smClobberConfig')
              },
            },
          })
          const host = document.createElement('div')
          host.innerHTML = html
          return { id: host.querySelector('span')?.id, noName: !host.querySelector('[name]') }
        }, backend)
        assert.deepEqual(result, { id: 'user-content-fn-host', noName: true })
      } finally { await page.close() }
    })
  }
})
