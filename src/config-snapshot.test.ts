import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { type LinkDecorator } from './inline-links.ts'
import { type FenceHandler } from './fence-handlers.ts'
import { type MarkdownConfig } from './config.ts'

// #153 (option b): a `StreamingMarkdownRenderer` freezes its config at
// construction. The constructor takes a shallow snapshot (`{ ...options }`), so a
// host that MUTATES the object it passed in — mid-stream — cannot retroactively
// change this instance's renders. Mutating the caller's object is the residual
// re-entry point for the old "config flipped mid-stream" failure class, which
// would otherwise corrupt the already-frozen prefix and the cached tokens.
describe('config frozen at construction (#153)', () => {
  const origDecorator: LinkDecorator = () => ' data-config="orig"'
  const leakDecorator: LinkDecorator = () => ' data-config="leaked"'
  const leakFence: FenceHandler = { render: (code) => `<div class="leaked-fence">${code.trim()}</div>` }

  // Content streamed in two chunks. It exercises every field the mutation touches:
  // a link (linkDecorator), a `$…$` span (mathSyntax), and a `demo` fence
  // (fenceHandlers) — so a leak of ANY mutated field would change the bytes.
  const chunk1 = '[a](https://example.com)\n\n'
  const chunk2 =
    '[a](https://example.com)\n\n' +
    '[b](https://example.org)\n\n' +
    '$x+1$\n\n' +
    '```demo\nhi\n```\n'

  function stream(host: HTMLElement, config: MarkdownConfig): string {
    const r = new StreamingMarkdownRenderer(host, config)
    r.update(chunk1)
    r.update(chunk2)
    return host.innerHTML
  }

  it('ignores post-construction mutation of the caller config object', () => {
    // The object the "live" renderer is constructed from — it will be mutated.
    const original: MarkdownConfig = {
      mathSyntax: false,
      linkDecorator: origDecorator,
    }

    // Control renderer: uses the original values throughout. `reference` is a copy
    // taken BEFORE any mutation, so it pins the pre-mutation config even as we
    // scribble on `original`.
    const reference: MarkdownConfig = { ...original }
    const controlHost = document.createElement('div')
    const controlOut = stream(controlHost, reference)

    // Live renderer: construct, stream a prefix, THEN mutate the caller's object.
    const liveHost = document.createElement('div')
    const live = new StreamingMarkdownRenderer(liveHost, original)
    live.update(chunk1)

    // Mutate every field mid-stream. If the renderer held `original` by reference,
    // these would take effect on the next update and diverge from the control.
    original.mathSyntax = true
    original.linkDecorator = leakDecorator
    original.fenceHandlers = { demo: leakFence }

    live.update(chunk2)
    const liveOut = liveHost.innerHTML

    // Byte-identical: the mutation was ignored. Sanity-check the discriminators are
    // actually present (so the test could fail if a leak occurred).
    assert.equal(liveOut, controlOut)
    assert.match(liveOut, /data-config="orig"/)
    assert.doesNotMatch(liveOut, /data-config="leaked"/)
    assert.doesNotMatch(liveOut, /leaked-fence/)
    // mathSyntax stayed off, so `$x+1$` is literal, not pending-math scaffolding.
    assert.doesNotMatch(liveOut, /math-inline--pending/)
    assert.match(liveOut, /\$x\+1\$/)
  })

  it('lets two renderers each honor their own config (snapshot preserves coexistence)', () => {
    const hostA = document.createElement('div')
    const hostB = document.createElement('div')
    const ra = new StreamingMarkdownRenderer(hostA, {
      linkDecorator: () => ' data-instance="a"',
    })
    const rb = new StreamingMarkdownRenderer(hostB, {
      linkDecorator: () => ' data-instance="b"',
    })

    // Interleave updates to prove there is no cross-instance bleed.
    ra.update('[l](https://a.test)')
    rb.update('[l](https://b.test)')
    ra.update('[l](https://a.test) x')
    rb.update('[l](https://b.test) y')

    assert.match(hostA.innerHTML, /data-instance="a"/)
    assert.match(hostB.innerHTML, /data-instance="b"/)
    assert.doesNotMatch(hostA.innerHTML, /data-instance="b"/)
    assert.doesNotMatch(hostB.innerHTML, /data-instance="a"/)
  })
})
