import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appLinkDecorator, type LinkDecorator, renderAnchor, setLinkDecorator } from './inline-links.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

// #146: renderAnchor exposes `isWorkspace` on the LinkDecoration lazily — the
// neutral default decorator never reads it, so the per-anchor
// isWorkspaceMarkdownLinkHref scan is skipped in the common case. The lazy getter
// must still deliver the correct value (and only when read). These pin that.

describe('renderAnchor lazy isWorkspace (#146)', () => {
  afterEach(() => setLinkDecorator(null))

  it('neutral default emits host-agnostic anchors (never reads isWorkspace)', () => {
    assert.equal(renderMarkdownUnsafe('[y](src/main.ts)'), '<p><a href="src/main.ts">y</a></p>')
    const html = renderMarkdownUnsafe('[x](https://example.com) and [y](docs/guide.md)')
    assert.doesNotMatch(html, /data-workspace-link|data-browser-link/)
  })

  it('a decorator that reads isWorkspace still gets the correct value per anchor', () => {
    setLinkDecorator(appLinkDecorator)
    // A relative in-workspace path resolves as a workspace link…
    assert.match(renderMarkdownUnsafe('[a](docs/guide.md)'), /data-workspace-link="true"/)
    // …an external http(s) URL is a browser link.
    assert.match(renderMarkdownUnsafe('[b](https://example.com)'), /data-browser-link="true"/)
    // Both, correctly distinguished, in a single render.
    const html = renderMarkdownUnsafe('[a](docs/guide.md) then [b](https://example.com)')
    assert.match(html, /docs\/guide\.md"[^>]*data-workspace-link="true"/)
    assert.match(html, /https:\/\/example\.com"[^>]*data-browser-link="true"/)
  })

  it('memoizes: a decorator reading isWorkspace twice sees one consistent value', () => {
    const reads: boolean[] = []
    const doubleReader: LinkDecorator = ({ isWorkspace }) => {
      reads.push(isWorkspace, isWorkspace) // access the getter twice
      return isWorkspace ? ' data-ws="1"' : ' data-ext="1"'
    }
    setLinkDecorator(doubleReader)
    assert.equal(renderAnchor('t', 'docs/guide.md'), '<a href="docs/guide.md" data-ws="1">t</a>')
    assert.deepEqual(reads, [true, true]) // consistent across repeated reads
  })
})
