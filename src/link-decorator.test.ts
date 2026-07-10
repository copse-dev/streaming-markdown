import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  appLinkDecorator,
  type LinkDecorator,
  renderAnchor,
  setLinkDecorator,
} from './inline-links.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

describe('LinkDecorator hook (#601, #112)', () => {
  // Global hook: always restore the neutral default so other suites are unaffected.
  afterEach(() => {
    setLinkDecorator(null)
  })

  it('emits neutral, host-agnostic anchors by default (#112)', () => {
    // No target, rel, class, or data-* routing hooks — just href (+ title).
    assert.equal(renderMarkdownUnsafe('[x](https://example.com)'), '<p><a href="https://example.com">x</a></p>')
    assert.equal(renderMarkdownUnsafe('[y](src/main.ts)'), '<p><a href="src/main.ts">y</a></p>')
    const html = renderMarkdownUnsafe('[x](https://example.com) and [y](src/main.ts)')
    assert.doesNotMatch(html, /data-browser-link/)
    assert.doesNotMatch(html, /data-workspace-link/)
    assert.doesNotMatch(html, /target="_blank"/)
  })

  it('carries a title through the neutral default without other attributes', () => {
    assert.equal(
      renderMarkdownUnsafe('[x](https://example.com "hi")'),
      '<p><a href="https://example.com" title="hi">x</a></p>',
    )
  })

  it('restores the pre-0.10 in-app behaviour with setLinkDecorator(appLinkDecorator) (#112 migration)', () => {
    setLinkDecorator(appLinkDecorator)
    assert.match(
      renderMarkdownUnsafe('[x](https://example.com)'),
      /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer" data-browser-link="true">x<\/a>/,
    )
    assert.match(
      renderMarkdownUnsafe('[y](src/main.ts)'),
      /<a href="src\/main\.ts" class="workspace-markdown-link" data-workspace-link="true">y<\/a>/,
    )
  })

  it('lets a host replace decoration at the renderAnchor seam', () => {
    // renderAnchor itself is unescaped assembly, so a host may emit any attrs.
    const minimal: LinkDecorator = ({ isWorkspace }) => (isWorkspace ? ' data-ws' : ' data-ext')
    setLinkDecorator(minimal)
    assert.equal(
      renderAnchor('label', 'https://example.com'),
      '<a href="https://example.com" data-ext>label</a>',
    )
    assert.equal(renderAnchor('label', 'src/main.ts'), '<a href="src/main.ts" data-ws>label</a>')
  })

  it('changes full-pipeline decoration within the escape allowlist vocabulary', () => {
    // Force every link (even workspace paths) to browser decoration. These attrs
    // are on the escapeHtmlTextNodes allowlist, so they survive the escape pass.
    const forceExternal: LinkDecorator = () =>
      ' target="_blank" rel="noopener noreferrer" data-browser-link="true"'
    setLinkDecorator(forceExternal)
    assert.match(
      renderMarkdownUnsafe('[y](src/main.ts)'),
      /<a href="src\/main\.ts" target="_blank" rel="noopener noreferrer" data-browser-link="true">y<\/a>/,
    )
    // Bare autolinks route through the same hook.
    assert.match(renderMarkdownUnsafe('see https://example.com'), /data-browser-link="true">https/)
  })

  it('restores the neutral default when passed null', () => {
    setLinkDecorator(() => ' custom')
    setLinkDecorator(null)
    assert.equal(renderAnchor('x', 'https://example.com'), '<a href="https://example.com">x</a>')
  })

  it('exposes the app default decorator for composition', () => {
    assert.equal(
      appLinkDecorator({ href: 'https://e.com', isWorkspace: false }),
      ' target="_blank" rel="noopener noreferrer" data-browser-link="true"',
    )
    assert.equal(
      appLinkDecorator({ href: 'a.ts', isWorkspace: true, title: 'T' }),
      ' class="workspace-markdown-link" data-workspace-link="true" title="T"',
    )
  })
})
