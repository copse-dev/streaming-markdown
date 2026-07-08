import '../tests/setup-dom-jsdom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createInputSmoother } from './smoothing.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

// #84 — OPTIONAL input smoother. These prove: (1) importing it changes nothing
// on the default emitter path; (2) it releases text incrementally against a
// fake clock/raf and flushes fully at stream end; (3) after flush the DOM
// converges with a single un-smoothed render; (4) prefers-reduced-motion (and
// the explicit disable flag) turn it into an immediate pass-through.

/** A deterministic clock + rAF the tests advance by hand — no real timers. */
function fakeScheduler() {
  let time = 0
  const queue = new Map<number, () => void>()
  let seq = 0
  return {
    now: () => time,
    requestFrame(cb: () => void): number {
      const id = ++seq
      queue.set(id, cb)
      return id
    },
    cancelFrame(id: number): void {
      queue.delete(id)
    },
    /** Advance the clock by `ms` and run every frame queued at entry (once). */
    tick(ms: number): void {
      time += ms
      const due = [...queue.entries()]
      queue.clear()
      for (const [, cb] of due) cb()
    },
    get pending(): number {
      return queue.size
    },
  }
}

describe('createInputSmoother — incremental reveal (fake clock/raf)', () => {
  it('releases a growing prefix a few characters per frame', () => {
    const clock = fakeScheduler()
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 100, // 1 char per 10ms
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      matchMedia: () => ({ matches: false }),
    })

    assert.equal(smoother.enabled, true)
    smoother.push('hello world') // 11 chars

    // Nothing released synchronously — reveal happens on frames.
    assert.deepEqual(seen, [])

    clock.tick(10) // +1 char
    clock.tick(10) // +1 char
    clock.tick(30) // +3 chars
    assert.deepEqual(seen, ['h', 'he', 'hello'])
    // Still mid-reveal, so another frame is queued.
    assert.ok(clock.pending > 0)

    smoother.dispose()
  })

  it('stops scheduling frames once the revealed prefix catches the target', () => {
    const clock = fakeScheduler()
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 1000, // 1 char/ms — outpaces the text
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    })

    smoother.push('abc')
    clock.tick(100) // plenty to reveal all 3 chars
    assert.equal(seen.at(-1), 'abc')
    assert.equal(clock.pending, 0, 'loop idles when caught up')

    // A later burst restarts the loop without a giant dt jump.
    smoother.push('abcdef')
    clock.tick(1) // 1 char/ms → +1 char only, proving lastTick was reseeded
    assert.equal(seen.at(-1), 'abcd')
    smoother.dispose()
  })

  it('flush releases the full target immediately and stops the loop', () => {
    const clock = fakeScheduler()
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 10, // deliberately slow
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    })

    smoother.push('the whole message')
    clock.tick(100) // only ~1 char revealed at 10 cps
    assert.notEqual(seen.at(-1), 'the whole message')

    smoother.flush()
    assert.equal(seen.at(-1), 'the whole message')
    assert.equal(clock.pending, 0, 'flush cancels the pending frame')

    // No further frames fire after flush.
    const count = seen.length
    clock.tick(1000)
    assert.equal(seen.length, count)
    smoother.dispose()
  })

  it('clamps revealed when a shorter target is pushed (never slices past the end)', () => {
    const clock = fakeScheduler()
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 1000,
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    })
    smoother.push('abcdefgh')
    clock.tick(100) // reveal everything
    assert.equal(seen.at(-1), 'abcdefgh')

    smoother.push('ab') // shorter — revealed must clamp
    smoother.flush()
    assert.equal(seen.at(-1), 'ab')
    smoother.dispose()
  })

  it('never splits a surrogate pair mid-frame', () => {
    const clock = fakeScheduler()
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 100, // 1 char (code unit) / 10ms
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    })
    // "a" + 😀 (a surrogate pair at UTF-16 indices 1-2) + "b".
    smoother.push('a\u{1F600}b')
    clock.tick(10) // budget = 1 → just "a"
    assert.equal(seen.at(-1), 'a')
    clock.tick(10) // budget = 2 → would land between the surrogate halves
    assert.equal(seen.at(-1), 'a', 'boundary steps back off the lone high surrogate')
    clock.tick(10) // budget = 3 → the whole emoji now fits
    assert.equal(seen.at(-1), 'a\u{1F600}')
    smoother.dispose()
  })
})

describe('createInputSmoother — disabled / reduced motion pass-through', () => {
  it('disabled:true passes every push straight through, no frames scheduled', () => {
    const clock = fakeScheduler()
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      disabled: true,
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    })
    assert.equal(smoother.enabled, false)
    smoother.push('one')
    smoother.push('one two')
    assert.deepEqual(seen, ['one', 'one two'])
    assert.equal(clock.pending, 0)
    smoother.dispose()
  })

  it('prefers-reduced-motion disables smoothing (mock matchMedia)', () => {
    const clock = fakeScheduler()
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      matchMedia: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' }),
    })
    assert.equal(smoother.enabled, false)
    smoother.push('immediate')
    assert.deepEqual(seen, ['immediate'])
    assert.equal(clock.pending, 0)
    smoother.dispose()
  })

  it('respectReducedMotion:false keeps smoothing even under reduced motion', () => {
    const clock = fakeScheduler()
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      respectReducedMotion: false,
      charsPerSecond: 100,
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      matchMedia: () => ({ matches: true }),
    })
    assert.equal(smoother.enabled, true)
    smoother.push('abc')
    assert.deepEqual(seen, [], 'still deferred to frames, not passed through')
    clock.tick(10)
    assert.equal(seen.at(-1), 'a')
    smoother.dispose()
  })
})

describe('createInputSmoother — dispose', () => {
  it('dispose stops the loop and ignores later push/flush', () => {
    const clock = fakeScheduler()
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 100,
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
    })
    smoother.push('abc')
    smoother.dispose()
    assert.equal(clock.pending, 0)
    smoother.push('def') // ignored
    smoother.flush() // ignored
    clock.tick(1000)
    assert.deepEqual(seen, [])
  })

  it('a frame that fires after dispose is a no-op', () => {
    // Schedule a frame, then dispose without cancelling via the queue: prove the
    // frame body bails on the `disposed` guard even if a straggler runs.
    const pending: (() => void)[] = []
    let time = 0
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 100,
      now: () => time,
      requestFrame: (cb) => {
        pending.push(cb)
        return pending.length
      },
      cancelFrame: () => {
        /* intentionally do NOT remove — simulate a straggler frame */
      },
    })
    smoother.push('abc')
    smoother.dispose()
    time += 100
    for (const cb of pending) cb() // straggler fires post-dispose
    assert.deepEqual(seen, [], 'disposed guard swallows the late frame')
  })
})

describe('createInputSmoother — default environment seams', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['requestAnimationFrame']
    delete (globalThis as Record<string, unknown>)['cancelAnimationFrame']
    delete (globalThis as Record<string, unknown>)['matchMedia']
  })

  it('falls back to setTimeout/performance/no-matchMedia when globals are absent', async () => {
    // No rAF, no matchMedia in node → default requestFrame uses setTimeout, and
    // reduced motion probes as false (smoothing enabled).
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 100000, // reveal in one frame
    })
    assert.equal(smoother.enabled, true)
    smoother.push('hi')
    await new Promise((r) => setTimeout(r, 40)) // let the timeout shim fire
    assert.equal(seen.at(-1), 'hi')
    smoother.dispose()
  })

  it('uses global requestAnimationFrame/cancelAnimationFrame when present', () => {
    const frames: (() => void)[] = []
    ;(globalThis as Record<string, unknown>)['requestAnimationFrame'] = (cb: () => void) => {
      frames.push(cb)
      return frames.length
    }
    let cancelled = 0
    ;(globalThis as Record<string, unknown>)['cancelAnimationFrame'] = () => {
      cancelled++
    }
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 100000,
    })
    smoother.push('abc')
    assert.equal(frames.length, 1, 'used global rAF')
    // Flush BEFORE the queued frame runs so cancel() drives the default
    // cancelAnimationFrame branch, then the flush releases the full target.
    smoother.flush()
    assert.equal(cancelled, 1, 'used global cancelAnimationFrame')
    assert.equal(seen.at(-1), 'abc')
    smoother.dispose()
  })

  it('cancels the setTimeout shim when flushing before a frame fires', async () => {
    // No global rAF → default requestFrame is a setTimeout; flushing before it
    // fires must clearTimeout it (the else branch of defaultCancelFrame).
    const seen: string[] = []
    const smoother = createInputSmoother({
      update: (t) => seen.push(t),
      charsPerSecond: 1, // slow: the frame would reveal ~nothing
    })
    smoother.push('abc')
    smoother.flush() // cancels the pending timeout, releases everything
    assert.equal(seen.at(-1), 'abc')
    const count = seen.length
    await new Promise((r) => setTimeout(r, 40)) // the cancelled timeout must not fire
    assert.equal(seen.length, count, 'the shim timeout was cleared')
    smoother.dispose()
  })

  it('reads global matchMedia when none is injected', () => {
    ;(globalThis as Record<string, unknown>)['matchMedia'] = (q: string) => ({
      matches: q === '(prefers-reduced-motion: reduce)',
    })
    const seen: string[] = []
    const smoother = createInputSmoother({ update: (t) => seen.push(t) })
    assert.equal(smoother.enabled, false, 'global matchMedia reported reduced motion')
    smoother.push('x')
    assert.deepEqual(seen, ['x'])
    smoother.dispose()
  })
})

describe('convergence — smoothed reveal equals a single un-smoothed render', () => {
  const SAMPLE = [
    '# Title',
    '',
    'A paragraph with **bold**, _italic_, and `code`.',
    '',
    '- one',
    '- two',
    '- three',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x = 1 < 2',
    '```',
    '',
    '> [!NOTE]',
    '> heads up',
    '',
    'Trailing prose 😀 done.',
  ].join('\n')

  function renderInto(fn: (renderer: StreamingMarkdownRenderer) => void): string {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    fn(renderer)
    return host.innerHTML
  }

  it('post-flush DOM matches feeding the full string at once', () => {
    const atRest = renderInto((r) => r.update(SAMPLE))

    const clock = fakeScheduler()
    const smoothed = renderInto((r) => {
      const smoother = createInputSmoother({
        update: (t) => r.update(t),
        charsPerSecond: 50,
        now: clock.now,
        requestFrame: clock.requestFrame,
        cancelFrame: clock.cancelFrame,
        matchMedia: () => ({ matches: false }),
      })
      // Deliver the text in chunky bursts, advancing the clock a little between
      // them — exactly the burst pattern smoothing is meant to steady.
      for (let i = 1; i <= SAMPLE.length; i += 7) {
        smoother.push(SAMPLE.slice(0, i))
        clock.tick(30)
      }
      smoother.push(SAMPLE)
      smoother.flush() // stream end
      smoother.dispose()
    })

    assert.equal(smoothed, atRest)
    // Sanity: the shared render actually produced non-trivial DOM.
    assert.ok(atRest.includes('<table'))
    assert.ok(atRest.includes('stream-complete'))
  })

  it('disabled smoother is byte-identical to feeding chunks straight to update', () => {
    const atRest = renderInto((r) => r.update(SAMPLE))
    const passThrough = renderInto((r) => {
      const smoother = createInputSmoother({ update: (t) => r.update(t), disabled: true })
      for (let i = 1; i <= SAMPLE.length; i += 5) smoother.push(SAMPLE.slice(0, i))
      smoother.push(SAMPLE)
      smoother.flush()
      smoother.dispose()
    })
    assert.equal(passThrough, atRest)
  })
})

describe('no leakage — the main entry does not bundle the smoother', () => {
  it('esbuild-bundled index.js contains no smoothing code', async () => {
    // The LAZY-LOADING.md measurement approach: bundle the main entry and assert
    // the opt-in module's identifiers are absent (it is reachable only through
    // the `@copse/streaming-markdown/smoothing` subpath, never re-exported here).
    const esbuild = await import('esbuild')
    const { fileURLToPath } = await import('node:url')
    const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url))
    const result = await esbuild.build({
      entryPoints: [indexPath],
      bundle: true,
      format: 'esm',
      write: false,
      logLevel: 'silent',
    })
    const code = result.outputFiles[0]?.text ?? ''
    assert.ok(code.length > 0, 'bundle produced output')
    assert.doesNotMatch(code, /createInputSmoother/, 'smoother must not land in the main bundle')
    assert.doesNotMatch(code, /prefers-reduced-motion/, 'reduced-motion probe must not leak')
  })

  it('the smoothing subpath bundles on its own', async () => {
    const esbuild = await import('esbuild')
    const { fileURLToPath } = await import('node:url')
    const smoothingPath = fileURLToPath(new URL('./smoothing.ts', import.meta.url))
    const result = await esbuild.build({
      entryPoints: [smoothingPath],
      bundle: true,
      format: 'esm',
      write: false,
      logLevel: 'silent',
    })
    const code = result.outputFiles[0]?.text ?? ''
    assert.match(code, /createInputSmoother/)
  })
})

describe('importing the smoother does not change the default emitter path', () => {
  it('renderMarkdown/sanitize output is identical with the module imported', () => {
    // The import at the top of this file is the whole point — assert core output
    // is unaffected by the module being present in the graph.
    const src = '# Hi\n\nsome *text* and `code`.'
    const html = sanitizeRenderedMarkdown(renderMarkdown(src))
    assert.match(html, /<h1>Hi<\/h1>/)
    assert.match(html, /<em>text<\/em>/)
  })
})
