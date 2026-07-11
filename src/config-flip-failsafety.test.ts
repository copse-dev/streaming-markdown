import '../tests/setup-dom-jsdom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { setMathSyntax } from './math-syntax.ts'
import { getFenceHandler, setFenceHandler } from './fence-handlers.ts'
import { setLinkDecorator } from './inline-links.ts'

// #153: flipping a process-wide config setter (setMathSyntax / setFenceHandler /
// setLinkDecorator) BETWEEN update() calls must fail safe. #145 chose option (a):
// an epoch-invalidation full re-render — so the stateful renderer converges to
// the output a fresh renderer produces under the new config, never leaving the
// committed prefix rendered under the stale config. This is the systematic
// fail-safety suite over the setters the issue names.

const BUILTIN_REC = getFenceHandler('rec')

afterEach(() => {
  setMathSyntax(null)
  setFenceHandler('rec', BUILTIN_REC)
  setLinkDecorator(null)
})

interface FlipCase {
  name: string
  part1: string
  full: string
  /** Apply the NEW config (mid-stream, and again for the fresh baseline). */
  flip(): void
  /** Reset to the OLD config before the mid-stream renderer's first update. */
  reset(): void
  /** A marker that only appears once the committed prefix is under the new config. */
  marker: RegExp
}

const cases: FlipCase[] = [
  {
    name: 'setMathSyntax (tokenization)',
    part1: 'Math $e^{i\\pi}$ done.\n\n',
    full: 'Math $e^{i\\pi}$ done.\n\nSecond paragraph.',
    flip: () => setMathSyntax(true),
    reset: () => setMathSyntax(false),
    marker: /math/i,
  },
  {
    name: 'setFenceHandler (fenced-block rendering)',
    part1: '```rec\nx\n```\n\n',
    full: '```rec\nx\n```\n\nafter',
    flip: () => setFenceHandler('rec', { render: (code) => `<div class="rec-rendered">${code.trim()}</div>` }),
    reset: () => setFenceHandler('rec', null),
    marker: /rec-rendered/,
  },
  {
    name: 'setLinkDecorator (anchor rendering)',
    part1: 'A [link](/x) here.\n\n',
    full: 'A [link](/x) here.\n\nmore [b](/y)',
    flip: () => setLinkDecorator(() => ' data-flip="1"'),
    reset: () => setLinkDecorator(null),
    marker: /data-flip="1"/,
  },
]

describe('mid-stream config-flip fail-safety (#153)', () => {
  for (const c of cases) {
    it(`${c.name}: a mid-stream flip converges to a fresh render`, () => {
      // Mid-stream: commit part1 under the OLD config, flip, then stream the rest.
      c.reset()
      const midEl = document.createElement('div')
      const mid = new StreamingMarkdownRenderer(midEl)
      mid.update(c.part1)
      c.flip()
      mid.update(c.full)

      // Baseline: a fresh renderer that saw the NEW config the whole time.
      c.flip()
      const freshEl = document.createElement('div')
      new StreamingMarkdownRenderer(freshEl).update(c.full)

      assert.equal(midEl.innerHTML, freshEl.innerHTML) // fail-safe: converged
      assert.match(midEl.innerHTML, c.marker) // committed prefix adopted the new config
    })
  }
})
