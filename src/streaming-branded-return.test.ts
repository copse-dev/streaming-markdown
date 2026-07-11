import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderStreamingMarkdown } from './streaming.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { setPresanitizedHtml } from './html-sink.ts'
import { type SanitizedHtml } from './sanitize.ts'

// #140: renderStreamingMarkdown returns SanitizedHtml (like renderMarkdown), not
// an unbranded string, so hosts keep the compile-time sink protection / Trusted
// Types story. The brand is compile-time only — these assertions are gated by
// `npm run typecheck`; a regression to `string` fails the build, not this run.
describe('renderStreamingMarkdown branded return (#140)', () => {
  it('is assignable to SanitizedHtml and to the presanitized sink', () => {
    // Type-level: only compiles while the return type is SanitizedHtml.
    const branded: SanitizedHtml = renderStreamingMarkdown('**done** and half')
    // Feeds the SanitizedHtml-only sink without an asSanitizedHtml cast.
    const el = document.createElement('div')
    setPresanitizedHtml(el, renderStreamingMarkdown('a paragraph'))

    // Runtime sanity: still a string, and the committed prefix matches the
    // unsafe render of the completed portion (branding changes no output).
    assert.equal(typeof branded, 'string')
    assert.ok(el.innerHTML.includes('a paragraph'))
    assert.ok(
      renderStreamingMarkdown('# Title\n\nrest').startsWith(renderMarkdownUnsafe('# Title')),
    )
  })
})
