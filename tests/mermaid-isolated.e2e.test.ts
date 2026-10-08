import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright-core'
import { buildMermaidFrameHtml } from '../src/mermaid-frame-document.ts'
import { findChromium } from './tt-browser-harness.ts'
import type * as Isolated from '../src/mermaid-isolated.ts'

declare const Adapter: typeof Isolated
declare const frameHandle: Isolated.DiagramFrame
const executablePath = findChromium()
if (!executablePath && process.env['E2E_REQUIRE_BROWSER'])
  throw new Error('Mermaid e2e requires Chromium')

describe(
  'isolated Mermaid in Chromium',
  { skip: executablePath ? false : 'No Chromium installed' },
  () => {
    let browser: Browser
    let page: Page
    let server: Server
    let origin: string
    const requests: string[] = []
    before(async () => {
      const parent = await build({
        entryPoints: ['src/mermaid-isolated.ts'],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'Adapter',
      })
      const child = await build({
        stdin: {
          contents:
            "import mermaid from 'mermaid'; import { startMermaidFrame } from './src/mermaid-frame-runtime.ts'; startMermaidFrame({ mermaid });",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        format: 'iife',
      })
      const frameHtml = buildMermaidFrameHtml(child.outputFiles![0]!.text)
      server = createServer((req, res) => {
        if (req.url === '/frame.html') {
          res.setHeader('Content-Type', 'text/html')
          res.end(frameHtml)
        } else if (req.url === '/') {
          res.setHeader('Content-Type', 'text/html')
          res.end(
            `<script>globalThis.__name = fn => fn</script><script>${parent.outputFiles![0]!.text}</script>`,
          )
        } else {
          requests.push(req.url ?? '')
          res.end('unexpected remote load')
        }
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No server address')
      origin = `http://127.0.0.1:${address.port}`
      browser = await chromium.launch({ executablePath: executablePath! })
      page = await browser.newPage()
      await page.goto(origin)
      await page.evaluate(async () => {
        const frame = Adapter.createMermaidFrame('graph LR; A[Start] --> B[Finish]', {
          url: '/frame.html',
          layoutWidth: 500,
        })
        Reflect.set(window, 'frameHandle', frame)
        document.body.append(frame.element)
        await frame.ready
      })
    })
    after(async () => {
      await browser?.close()
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    })

    it('renders only inside the opaque frame and denies parent access', async () => {
      assert.equal(await page.locator('svg').count(), 0)
      const frame = page.frames().find((frame) => frame.url().endsWith('/frame.html'))!
      assert.ok(await frame.locator('svg').count())
      assert.equal(
        await frame.evaluate(() => {
          try {
            return !!parent.document
          } catch {
            return false
          }
        }),
        false,
      )
      assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
    })

    it('blocks SVG, CSS, font, script, fetch, nested frame and object resource loads', async () => {
      requests.length = 0
      const frame = page.frames().find((frame) => frame.url().endsWith('/frame.html'))!
      const directives = await frame.evaluate(async (origin) => {
        const violations: string[] = []
        document.addEventListener('securitypolicyviolation', (event) =>
          violations.push(event.effectiveDirective),
        )
        const svg = document.querySelector('svg')!
        for (const tag of ['image', 'use', 'feImage']) {
          const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
          node.setAttribute('href', `${origin}/probe-${tag}.svg#x`)
          svg.append(node)
        }
        const style = document.createElement('style')
        style.textContent = `@import url('${origin}/probe.css'); @font-face { font-family: Probe; src: url('${origin}/probe.woff2'); } body { background-image: url('${origin}/probe-bg.png'); font-family: Probe; }`
        document.head.append(style)
        const label = document.createElement('p')
        label.textContent = 'Force font load'
        document.body.append(label)
        const img = new Image()
        img.src = `${origin}/probe.png`
        document.body.append(img)
        const script = document.createElement('script')
        script.src = `${origin}/probe.js`
        document.body.append(script)
        const nested = document.createElement('iframe')
        nested.src = `${origin}/probe-frame`
        document.body.append(nested)
        const object = document.createElement('object')
        object.data = `${origin}/probe-object`
        document.body.append(object)
        try {
          await fetch(`${origin}/probe-fetch`)
        } catch {
          /* expected */
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
        return violations
      }, origin)
      for (const directive of [
        'img-src',
        'connect-src',
        'style-src-elem',
        'font-src',
        'script-src-elem',
        'frame-src',
        'object-src',
      ])
        assert.ok(directives.includes(directive), directive)
      assert.deepEqual(
        requests.filter((path) => path.startsWith('/probe')),
        [],
      )
    })

    it('cancels pending work on disposal, removal and abort; rejects oversized source before loading', async () => {
      const results = await page.evaluate(async () => {
        const make = () => Adapter.createMermaidFrame('graph LR; A-->B', { url: '/frame.html' })
        const disposed = make()
        const d = disposed.ready.catch(() => 'disposed')
        disposed.dispose()
        disposed.dispose()
        const removed = make()
        const r = removed.ready.catch(() => 'removed')
        document.body.append(removed.element)
        removed.element.remove()
        const controller = new AbortController()
        const aborted = Adapter.createMermaidFrame('graph LR; A-->B', {
          url: '/frame.html',
          signal: controller.signal,
        })
        const a = aborted.ready.catch(() => 'aborted')
        controller.abort()
        const oversized = Adapter.createMermaidFrame('x'.repeat(50_001), { url: '/frame.html' })
        const o = oversized.ready.catch(() => 'oversized')
        frameHandle.dispose()
        return {
          statuses: await Promise.all([d, r, a, o]),
          oversizedUrl: oversized.element.getAttribute('src'),
          frames: document.querySelectorAll('iframe').length,
        }
      })
      assert.deepEqual(results.statuses, ['disposed', 'removed', 'aborted', 'oversized'])
      assert.equal(results.oversizedUrl, null)
      assert.equal(results.frames, 0)
    })
  },
)
