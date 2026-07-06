import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StreamingMarkdownRenderer } from './streaming.ts'

// Drives the incremental renderer through the transient states where a pending
// list marker / list-continuation / block appears with no inner content yet (the
// "clear pending" branches the pending-tail syncers take when pendingInner is
// empty). Streaming a document one character at a time necessarily passes through
// a bare "- " / "> " marker before its text arrives.

/** Feed `text` one character at a time; return the final host. */
function streamCharByChar(text: string): HTMLElement {
  const host = document.createElement('div')
  const r = new StreamingMarkdownRenderer(host)
  for (let i = 1; i <= text.length; i++) r.update(text.slice(0, i))
  return host
}

function completeText(host: HTMLElement): string {
  return host.querySelector('.stream-complete')?.textContent ?? ''
}

describe('streaming through empty pending markers', () => {
  it('streams a multi-item bullet list, passing through bare "- " markers', () => {
    const host = streamCharByChar('- alpha\n- bravo\n- charlie\n')
    const items = host.querySelectorAll('.stream-complete li')
    assert.equal(items.length, 3)
    assert.deepEqual([...items].map((li) => li.textContent?.trim()), ['alpha', 'bravo', 'charlie'])
  })

  it('streams an ordered list through bare "1. " markers', () => {
    const host = streamCharByChar('1. one\n2. two\n3. three\n')
    assert.equal(host.querySelectorAll('.stream-complete ol > li').length, 3)
  })

  it('streams a list item with a wrapped continuation line', () => {
    // The continuation line ("  more") is pending (indented under the item) before
    // its text arrives — exercising the list-continuation clear/settle path.
    const host = streamCharByChar('- item one\n  continued here\n- item two\n')
    assert.match(completeText(host), /continued here/)
    assert.equal(host.querySelectorAll('.stream-complete li').length, 2)
  })

  it('streams a paragraph following a list (block pending appears then commits)', () => {
    const host = streamCharByChar('- a\n- b\n\nAfter the list.\n')
    assert.match(completeText(host), /After the list\./)
  })

  it('streams a blockquote through a bare "> " marker', () => {
    const host = streamCharByChar('> quoted line\n> second line\n')
    assert.equal(host.querySelectorAll('.stream-complete blockquote').length, 1)
  })

  it('streams a nested list, passing through empty nested markers', () => {
    const host = streamCharByChar('- outer\n  - inner one\n  - inner two\n- outer two\n')
    assert.ok(host.querySelector('.stream-complete li ul'))
  })

  it('final at-rest render matches after fully streaming', () => {
    const md = '- a\n- b\n\ntext\n'
    const host = streamCharByChar(md)
    // No pending scaffolding should remain once the trailing newline commits.
    assert.equal(host.querySelector('.stream-pending')?.textContent ?? '', '')
  })
})
