// Fail-closed contract (#104): the safe `renderMarkdown` sanitizes, which needs
// a DOM/backend. With neither a registered backend nor the native Sanitizer API
// (this file deliberately does NOT install jsdom or a backend — bare Node), it
// must THROW rather than return unsafe HTML. The zero-dependency, DOM-free path
// for that environment is `renderMarkdownUnsafe`, which still works.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, renderMarkdownUnsafe } from './renderer.ts'

describe('renderMarkdown fail-closed with no sanitizer backend — #104', () => {
  it('throws instead of returning unsafe HTML', () => {
    assert.throws(() => renderMarkdown('# Hi'), /sanitizer backend/i)
  })

  it('renderMarkdownUnsafe still works (zero-dependency, DOM-free)', () => {
    assert.equal(renderMarkdownUnsafe('# Hi'), '<h1>Hi</h1>')
  })
})
