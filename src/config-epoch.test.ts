import '../tests/setup-dom-jsdom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { setMathSyntax } from './math-syntax.ts'
import { type FenceHandler, getFenceHandler, setFenceHandler } from './fence-handlers.ts'
import { bumpConfigEpoch, configEpoch, restoreConfigEpoch } from './config-epoch.ts'

// #145: the stateful StreamingMarkdownRenderer validates its token cache
// (IncrementalSourceScanner) by byte prefix and its frozen DOM by frozenSource
// bytes — but tokenization depends on `isMathSyntaxEnabled()` and rendering on
// the html policy / handlers / decorators. A config setter flipped mid-stream
// used to leave the frozen prefix permanently divergent from a fresh render
// (fail-unsafe). Every setter now bumps a config epoch that `update()` checks,
// dropping caches and re-rendering the committed prefix under the new config.

const BUILTIN_FOO = getFenceHandler('foo')

afterEach(() => {
  setMathSyntax(null)
  setFenceHandler('foo', BUILTIN_FOO)
})

/** Stream `full` in two updates, flipping config via `flip` between them. */
function streamWithMidFlip(part1: string, full: string, flip: () => void): string {
  const el = document.createElement('div')
  const r = new StreamingMarkdownRenderer(el)
  r.update(part1)
  flip()
  r.update(full)
  return el.innerHTML
}

/** A fresh renderer streamed entirely under the post-flip config. */
function streamFresh(full: string): string {
  const el = document.createElement('div')
  new StreamingMarkdownRenderer(el).update(full)
  return el.innerHTML
}

describe('config-epoch mid-stream invalidation (#145)', () => {
  it('re-tokenizes the committed prefix when math syntax flips mid-stream', () => {
    const full = 'Euler: $e^{i\\pi}+1=0$ is neat.\n\nSecond paragraph.'
    setMathSyntax(false)
    const mid = streamWithMidFlip('Euler: $e^{i\\pi}+1=0$ is neat.\n\n', full, () =>
      setMathSyntax(true),
    )
    setMathSyntax(true)
    const fresh = streamFresh(full)
    assert.equal(mid, fresh) // converged — the frozen prefix was not left stale
    assert.match(mid, /math/i) // and it actually picked up the new grammar
  })

  it('re-renders committed blocks when a fence handler is registered mid-stream', () => {
    const handler: FenceHandler = {
      render: (code) => `<div class="foo-rendered">${code.trim()}</div>`,
    }
    const full = '```foo\nhello\n```\n\nafter'
    const mid = streamWithMidFlip('```foo\nhello\n```\n\n', full, () =>
      setFenceHandler('foo', handler),
    )
    setFenceHandler('foo', handler)
    const fresh = streamFresh(full)
    assert.equal(mid, fresh)
    assert.match(mid, /foo-rendered/) // the committed fence adopted the handler
  })

  it('does not invalidate when no config changed between updates', () => {
    // A stable config stream converges to a fresh render with no help from the
    // epoch (the guard is a no-op here) — the baseline the flip cases build on.
    const full = 'One.\n\nTwo.\n\nThree.'
    const el = document.createElement('div')
    const r = new StreamingMarkdownRenderer(el)
    r.update('One.\n\n')
    r.update('One.\n\nTwo.\n\n')
    r.update(full)
    assert.equal(el.innerHTML, streamFresh(full))
  })

  it('a policy-configured instance is not self-invalidated every frame', () => {
    // withRenderPolicies applies+restores scoped policy setters each update; those
    // bumps are epoch-neutral, so an instance with options streams correctly (a
    // per-frame full invalidation would still be correct output, but this pins
    // that the neutralization keeps the scoped seam from moving the epoch).
    const full = '# Title\n\n<b>bold</b> and text\n\nlast line'
    const el = document.createElement('div')
    const r = new StreamingMarkdownRenderer(el, { htmlPolicy: 'escape' })
    r.update('# Title\n\n')
    r.update('# Title\n\n<b>bold</b> and text\n\n')
    r.update(full)
    const fresh = document.createElement('div')
    new StreamingMarkdownRenderer(fresh, { htmlPolicy: 'escape' }).update(full)
    assert.equal(el.innerHTML, fresh.innerHTML)
  })
})

describe('config-epoch primitive', () => {
  it('bump advances and restore resets the epoch', () => {
    const start = configEpoch()
    bumpConfigEpoch()
    bumpConfigEpoch()
    assert.equal(configEpoch(), start + 2)
    restoreConfigEpoch(start)
    assert.equal(configEpoch(), start)
  })
})
