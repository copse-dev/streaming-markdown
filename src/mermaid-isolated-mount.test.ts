import '../tests/setup-dom-jsdom.ts'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import {
  ISOLATED_DIAGRAM_ATTRIBUTE,
  ISOLATED_DIAGRAM_CLASS,
  mountIsolatedDiagrams,
} from './mermaid-isolated.ts'

// mountIsolatedDiagrams over a real streaming renderer: frames are mounted only for closed fences,
// once each, and survive every later update (a closed fence is frozen). jsdom never loads the frame
// document, so each test drives the frame's private port by hand.

const DOC =
  'Intro paragraph.\n\n```mermaid\ngraph LR; A-->B\n```\n\nA paragraph after the diagram that keeps streaming.\n\n- one\n- two\n'

const channels: MessageChannel[] = []
const OriginalChannel = globalThis.MessageChannel
const savedObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')

beforeEach(() => {
  channels.length = 0
  globalThis.MessageChannel = class extends OriginalChannel {
    constructor() {
      super()
      channels.push(this)
    }
  }
  Object.defineProperty(globalThis, 'MutationObserver', {
    value: window.MutationObserver,
    configurable: true,
  })
})

afterEach(() => {
  globalThis.MessageChannel = OriginalChannel
  for (const channel of channels) {
    channel.port1.close()
    channel.port2.close()
  }
  if (savedObserver) Object.defineProperty(globalThis, 'MutationObserver', savedObserver)
  else Reflect.deleteProperty(globalThis, 'MutationObserver')
})

/** Let the frame "load" and answer its render request on the private port. */
function answer(frame: HTMLIFrameElement, reply: unknown): void {
  Object.defineProperty(frame, 'contentWindow', {
    configurable: true,
    value: { postMessage: () => {} },
  })
  frame.dispatchEvent(new window.Event('load'))
  channels.at(-1)!.port2.postMessage(reply)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Poll for `check`: fixed sleeps flake when the suite runs in parallel or under coverage. */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await wait(5)
  }
}
/** Wait until the frame's reply has settled a diagram (its state leaves `pending`). */
const untilSettled = (diagram: Element) =>
  until(() => diagram.getAttribute(ISOLATED_DIAGRAM_ATTRIBUTE) !== 'pending')

describe('mountIsolatedDiagrams over a streaming renderer', () => {
  it('mounts a closed fence once, never the forming one, and the frame survives later updates', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const renderer = new StreamingMarkdownRenderer(host)
    const settled: string[] = []
    const options = {
      url: '/frame.html',
      onSettled: (_: HTMLElement, state: string) => settled.push(state),
    }
    const closeAt = DOC.indexOf('```\n\nA paragraph') + 3
    let frame: HTMLIFrameElement | null = null
    for (let i = 1; i <= DOC.length; i++) {
      renderer.update(DOC.slice(0, i))
      mountIsolatedDiagrams(host, options)
      const frames = host.querySelectorAll('iframe')
      if (i < closeAt) assert.equal(frames.length, 0, `mounted before the fence closed (at ${i})`)
      if (frames.length) {
        assert.equal(frames.length, 1)
        if (frame) assert.equal(frames[0], frame, `frame replaced at ${i}`)
        frame ??= frames[0]!
        if (i === closeAt + 20) {
          // Source on screen, frame held out of layout while it renders.
          assert.ok(host.querySelector('.mermaid-diagram > pre.mermaid'))
          assert.equal(frame.style.visibility, 'hidden')
          answer(frame, { type: 'rendered', width: 320, height: 120 })
          await untilSettled(frame.closest('.mermaid-diagram')!)
        }
      }
    }
    assert.ok(frame?.isConnected)
    const diagram = frame.closest<HTMLElement>('.mermaid-diagram')!
    assert.equal(diagram.getAttribute(ISOLATED_DIAGRAM_ATTRIBUTE), 'rendered')
    assert.ok(diagram.classList.contains(ISOLATED_DIAGRAM_CLASS))
    assert.ok(!diagram.classList.contains('mermaid-diagram--pending'))
    assert.equal(diagram.querySelector('pre'), null)
    assert.equal(frame.style.visibility, '')
    assert.deepEqual(settled, ['rendered'])
    assert.equal(channels.length, 1, 'one frame for one diagram')
    host.remove()
  })

  it('keeps the escaped source as the fallback when the frame fails', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update(DOC)
    let failedDiagram: HTMLElement | null = null
    mountIsolatedDiagrams(host, {
      url: '/frame.html',
      onSettled: (diagram, state) => {
        if (state === 'failed') failedDiagram = diagram
      },
    })
    answer(host.querySelector('iframe')!, { type: 'rendered', width: Infinity, height: 1 })
    await untilSettled(host.querySelector('.mermaid-diagram')!)
    assert.ok(failedDiagram)
    const diagram = host.querySelector<HTMLElement>('.mermaid-diagram')!
    assert.equal(diagram.getAttribute(ISOLATED_DIAGRAM_ATTRIBUTE), 'failed')
    assert.equal(diagram.querySelector('iframe'), null)
    assert.equal(diagram.querySelector('pre.mermaid')?.textContent, 'graph LR; A-->B')
    // A failed diagram is not retried by later calls.
    mountIsolatedDiagrams(host, { url: '/frame.html' })
    assert.equal(channels.length, 1)
    host.remove()
  })

  it('mounts every diagram of an at-rest render', () => {
    const host = document.createElement('div')
    host.innerHTML = String(
      renderMarkdown('```mermaid\ngraph LR; A-->B\n```\n\n- item\n\n  ```mermaid\n  graph TD; C-->D\n  ```\n'),
    )
    document.body.append(host)
    mountIsolatedDiagrams(host, { url: '/frame.html' })
    mountIsolatedDiagrams(host, { url: '/frame.html' })
    assert.equal(host.querySelectorAll('iframe').length, 2)
    assert.equal(channels.length, 2)
    host.remove()
  })
})

describe('mountIsolatedDiagrams lazy mounting', () => {
  type Observed = { callback: IntersectionObserverCallback; disconnected: boolean; options?: IntersectionObserverInit }
  const observers: Observed[] = []
  const savedIO = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  const savedIdle = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')

  beforeEach(() => {
    observers.length = 0
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        record: Observed
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.record = { callback, disconnected: false, ...(options ? { options } : {}) }
          observers.push(this.record)
        }
        observe() {}
        disconnect() {
          this.record.disconnected = true
        }
      },
    })
    Object.defineProperty(globalThis, 'requestIdleCallback', {
      configurable: true,
      value: (callback: () => void) => setTimeout(callback, 0),
    })
  })

  afterEach(() => {
    for (const [key, saved] of [
      ['IntersectionObserver', savedIO],
      ['requestIdleCallback', savedIdle],
    ] as const)
      if (saved) Object.defineProperty(globalThis, key, saved)
      else Reflect.deleteProperty(globalThis, key)
  })

  const intersect = (observer: Observed, isIntersecting: boolean) =>
    observer.callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)

  function renderedHost(): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = String(renderMarkdown('```mermaid\ngraph LR; A-->B\n```\n'))
    document.body.append(host)
    return host
  }

  it('defers the frame until the diagram has stayed near the viewport, then mounts at idle', async () => {
    const host = renderedHost()
    mountIsolatedDiagrams(host, { url: '/frame.html', lazy: { debounce: 20, rootMargin: '100px' } })
    mountIsolatedDiagrams(host, { url: '/frame.html', lazy: true })
    const diagram = host.querySelector<HTMLElement>('.mermaid-diagram')!
    assert.equal(diagram.getAttribute(ISOLATED_DIAGRAM_ATTRIBUTE), 'deferred')
    assert.equal(observers.length, 1, 'idempotent while deferred')
    assert.equal(observers[0]!.options?.rootMargin, '100px')
    assert.equal(host.querySelector('iframe'), null)

    // Scrolled past before the debounce: nothing mounts.
    intersect(observers[0]!, true)
    intersect(observers[0]!, false)
    await wait(40)
    assert.equal(host.querySelector('iframe'), null)

    intersect(observers[0]!, true)
    await until(() => !!host.querySelector('iframe'))
    assert.ok(observers[0]!.disconnected)
    assert.equal(diagram.getAttribute(ISOLATED_DIAGRAM_ATTRIBUTE), 'pending')
    assert.equal(diagram.querySelector('pre.mermaid')?.textContent, 'graph LR; A-->B')
    host.remove()
  })

  it('skips a deferred diagram removed before it became due, and mounts at once without IntersectionObserver', async () => {
    const host = renderedHost()
    mountIsolatedDiagrams(host, { url: '/frame.html', lazy: { debounce: 0 } })
    intersect(observers[0]!, true)
    host.remove()
    await wait(20)
    assert.equal(host.querySelector('iframe'), null)
    const mountedBeforeRemoval = channels.length
    assert.equal(mountedBeforeRemoval, 0)

    // Without requestIdleCallback (Safari) the due mount falls back to a timer.
    Reflect.deleteProperty(globalThis, 'requestIdleCallback')
    const late = renderedHost()
    mountIsolatedDiagrams(late, { url: '/frame.html', lazy: { debounce: 0 } })
    intersect(observers.at(-1)!, true)
    await until(() => !!late.querySelector('iframe'))
    late.remove()

    Reflect.deleteProperty(globalThis, 'IntersectionObserver')
    const eager = renderedHost()
    mountIsolatedDiagrams(eager, { url: '/frame.html', lazy: true })
    assert.ok(eager.querySelector('iframe'))
    eager.remove()
  })
})
