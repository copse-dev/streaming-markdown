import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { buildMermaidFrameHtml } from './mermaid-frame-document.ts'
import {
  parseDiagramSize,
  parseDiagramSource,
  MAX_DIAGRAM_SOURCE_LENGTH,
} from './mermaid-frame-protocol.ts'
import { createMermaidRunner, type FrameMermaid } from './mermaid-frame-runtime.ts'

describe('isolated Mermaid protocol and document', () => {
  it('accepts only bounded source messages and finite positive dimensions', () => {
    assert.equal(
      parseDiagramSource({ type: 'render', source: 'graph LR; A-->B' }),
      'graph LR; A-->B',
    )
    for (const value of [
      null,
      {},
      'render',
      { type: 'render', source: 1 },
      { type: 'render', source: 'x'.repeat(MAX_DIAGRAM_SOURCE_LENGTH + 1) },
      Object.create({ type: 'render', source: 'x' }),
    ])
      assert.equal(parseDiagramSource(value), null)
    assert.deepEqual(parseDiagramSize({ type: 'rendered', width: 1e9, height: 1.5 }), {
      width: 4096,
      height: 1.5,
    })
    for (const width of [0, -1, NaN, Infinity, '20', null])
      assert.equal(parseDiagramSize({ type: 'rendered', width, height: 20 }), null)
    assert.equal(parseDiagramSize(Object.create({ type: 'rendered', width: 20, height: 20 })), null)
  })
  it('pins exactly the embedded bootstrap and provides no resource URL allowances', () => {
    const script = 'console.log("café")\n'
    const html = buildMermaidFrameHtml(script, 'body { color: red; }')
    assert.ok(html.includes(`<script>${script}</script>`))
    assert.ok(
      html.includes(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`),
    )
    for (const directive of [
      'default-src',
      'img-src',
      'connect-src',
      'font-src',
      'frame-src',
      'worker-src',
      'object-src',
      'base-uri',
      'form-action',
    ])
      assert.ok(html.includes(`${directive} 'none'`))
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<style>'))
    assert.throws(() => buildMermaidFrameHtml('</ScRiPt><img>'), /terminator/)
    assert.throws(() => buildMermaidFrameHtml('', '</STYLE><img>'), /terminator/)
  })
})

describe('isolated Mermaid runner', () => {
  it('sets strict security, retries a failed candidate, and initializes once', async () => {
    const dom = new JSDOM(
      '<div class="mermaid-diagram"><pre class="mermaid">flowchart LR\nA[Start] --> B[End]</pre></div>',
    )
    let initializations = 0
    let runs = 0
    const mermaid: FrameMermaid = {
      initialize(config) {
        initializations++
        assert.equal(config.securityLevel, 'strict')
        assert.equal(config.maxTextSize, MAX_DIAGRAM_SOURCE_LENGTH)
      },
      async run({ nodes }) {
        runs++
        if (runs === 1) throw new Error('retry')
        nodes[0]!.innerHTML = '<svg></svg>'
        nodes[0]!.dataset['processed'] = 'true'
      },
    }
    const run = createMermaidRunner(mermaid)
    await run(dom.window.document)
    await run(dom.window.document)
    assert.equal(initializations, 1)
    assert.equal(runs, 2)
    assert.ok(dom.window.document.querySelector('svg'))
    dom.window.close()
  })
  it('fails without returning SVG or delegates to an inert host fallback', async () => {
    const dom = new JSDOM(
      '<div class="mermaid-diagram"><pre class="mermaid">bad source</pre></div>',
    )
    const mermaid: FrameMermaid = { initialize() {}, async run() {} }
    await assert.rejects(createMermaidRunner(mermaid)(dom.window.document), /could not be rendered/)
    await createMermaidRunner(mermaid, {
      onError(container, source) {
        container.textContent = source
      },
    })(dom.window.document)
    assert.equal(dom.window.document.body.textContent, 'bad source')
    assert.equal(dom.window.document.querySelector('pre'), null)
    dom.window.close()
  })
})

describe('isolated frame host lifecycle', () => {
  it('accepts private-port dimensions, rejects malformed replies and releases removed frames', async () => {
    const { createMermaidFrame } = await import('./mermaid-isolated.ts')
    const dom = new JSDOM('<body></body>', { url: 'https://host.test/' })
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
    const OriginalChannel = globalThis.MessageChannel
    const channels: MessageChannel[] = []
    class CapturedChannel extends OriginalChannel {
      constructor() {
        super()
        channels.push(this)
      }
    }
    Object.defineProperty(globalThis, 'document', {
      value: dom.window.document,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'MutationObserver', {
      value: dom.window.MutationObserver,
      configurable: true,
    })
    globalThis.MessageChannel = CapturedChannel
    try {
      const frame = createMermaidFrame('graph LR; A-->B', { url: '/frame.html', layoutWidth: 8000 })
      assert.equal(frame.element.style.width, '4096px')
      assert.equal(frame.element.getAttribute('sandbox'), 'allow-scripts')
      dom.window.document.body.append(frame.element)
      frame.element.dispatchEvent(new dom.window.Event('load'))
      channels.at(-1)!.port2.postMessage({ type: 'rendered', width: 250, height: 150 })
      assert.deepEqual(await frame.ready, { width: 250, height: 150 })
      assert.equal(frame.element.dataset['rendered'], 'true')
      frame.dispose()
      frame.dispose()
      const malformed = createMermaidFrame('source', { url: '/frame.html', layoutWidth: NaN })
      assert.equal(malformed.element.style.width, '300px')
      const rejected = assert.rejects(malformed.ready, /did not render/)
      channels.at(-1)!.port2.postMessage({ type: 'rendered', width: Infinity, height: 1 })
      await rejected
      malformed.dispose()
      const removed = createMermaidFrame('source', { url: '/frame.html' })
      const removal = assert.rejects(removed.ready, /did not render/)
      dom.window.document.body.append(removed.element)
      removed.element.remove()
      await removal
      const abort = new AbortController()
      abort.abort()
      const cancelled = createMermaidFrame('source', { url: '/frame.html', signal: abort.signal })
      await assert.rejects(cancelled.ready, /cancelled/)
      assert.equal(cancelled.element.getAttribute('src'), null)
      const pendingAbort = new AbortController()
      const pending = createMermaidFrame('source', {
        url: '/frame.html',
        signal: pendingAbort.signal,
      })
      const aborted = assert.rejects(pending.ready, /did not render/)
      pendingAbort.abort()
      await aborted
    } finally {
      globalThis.MessageChannel = OriginalChannel
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else Reflect.deleteProperty(globalThis, 'document')
      if (previousObserver) Object.defineProperty(globalThis, 'MutationObserver', previousObserver)
      else Reflect.deleteProperty(globalThis, 'MutationObserver')
      dom.window.close()
    }
  })
})

describe('frame bootstrap', () => {
  it('accepts one parent request, replies with dimensions or failure, and supports disposal', async () => {
    const { startMermaidFrame } = await import('./mermaid-frame-runtime.ts')
    const dom = new JSDOM('<body></body>')
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
    Object.defineProperty(globalThis, 'document', {
      value: dom.window.document,
      configurable: true,
    })
    const channels: MessageChannel[] = []
    const dispatch = (data: unknown, port?: MessagePort, fromParent = true): void => {
      const event = new dom.window.MessageEvent('message', { data, ports: port ? [port] : [] })
      Object.defineProperty(event, 'source', { value: fromParent ? dom.window : null })
      dom.window.dispatchEvent(event)
    }
    const channel = (): MessageChannel => {
      const value = new MessageChannel()
      channels.push(value)
      return value
    }
    const reply = (port: MessagePort): Promise<unknown> =>
      new Promise((resolve) => {
        port.onmessage = (event) => resolve(event.data)
      })
    const mermaid: FrameMermaid = {
      initialize() {},
      async run({ nodes }) {
        nodes[0]!.innerHTML = '<svg viewBox="0 0 300 200"></svg>'
      },
    }
    try {
      const dispose = startMermaidFrame({ mermaid })
      const success = channel()
      dispatch({ type: 'render', source: 'graph LR; A-->B' }, success.port2, false)
      dispatch({ type: 'render', source: 'graph LR; A-->B' })
      dispatch({ type: 'render', source: 123 }, success.port2)
      const result = reply(success.port1)
      dispatch({ type: 'render', source: 'graph LR; A-->B' }, success.port2)
      assert.deepEqual(await result, { type: 'rendered', width: 300, height: 200 })
      assert.equal(dom.window.document.querySelector('svg')?.style.width, '100%')
      dispose()
      const failed = channel()
      const failure = reply(failed.port1)
      const stopFailure = startMermaidFrame({
        mermaid,
        prepare: async () => {
          throw new Error('font failure')
        },
      })
      dispatch({ type: 'render', source: 'graph LR; A-->B' }, failed.port2)
      assert.deepEqual(await failure, { type: 'failed' })
      stopFailure()
      const noSvg = channel()
      const missing = reply(noSvg.port1)
      const stopMissing = startMermaidFrame({
        mermaid: { initialize() {}, async run() {} },
        onError(container) {
          container.textContent = 'fallback'
        },
      })
      dispatch({ type: 'render', source: 'bad' }, noSvg.port2)
      assert.deepEqual(await missing, { type: 'failed' })
      stopMissing()
      let finishPrepare = (): void => {}
      const preparing = new Promise<void>((resolve) => {
        finishPrepare = resolve
      })
      const stop = startMermaidFrame({ mermaid, prepare: () => preparing })
      dispatch({ type: 'render', source: 'graph LR; A-->B' }, channel().port2)
      stop()
      finishPrepare()
      await preparing
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      for (const value of channels) {
        value.port1.close()
        value.port2.close()
      }
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else Reflect.deleteProperty(globalThis, 'document')
      dom.window.close()
    }
  })
})
