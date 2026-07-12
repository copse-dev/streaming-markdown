import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appLinkDecorator, type LinkDecoration, renderAnchor } from './inline-links.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { withConfig } from './config.ts'

// #146: workspace-ness is host residue and has been evicted from the neutral
// core. `renderAnchor` no longer computes `isWorkspace` — the `LinkDecoration`
// it hands a decorator carries only `href`/`title`, so the per-anchor
// `isWorkspaceMarkdownLinkHref` URL scan no longer runs in the core path. The
// opt-in `appLinkDecorator` (behind `@copse/streaming-markdown/host/workspace`)
// derives workspace-ness from the `href` itself. These pin that split.

describe('workspace decoration lives in appLinkDecorator, not the core (#146)', () => {
  it('the core hands decorators only href/title — no isWorkspace residue', () => {
    let seen: LinkDecoration | undefined
    withConfig(
      {
        linkDecorator: (decoration) => {
          seen = decoration
          return ''
        },
      },
      () => renderAnchor('t', 'docs/guide.md'),
    )
    assert.deepEqual(Object.keys(seen ?? {}), ['href'])
    assert.equal(seen?.href, 'docs/guide.md')
    // The workspace-host flag is gone from the neutral core's decoration shape.
    assert.equal((seen as unknown as Record<string, unknown>)['isWorkspace'], undefined)
  })

  it('neutral default emits host-agnostic anchors (no workspace URL scan runs)', () => {
    assert.equal(renderMarkdownUnsafe('[y](src/main.ts)'), '<p><a href="src/main.ts">y</a></p>')
    const html = renderMarkdownUnsafe('[x](https://example.com) and [y](docs/guide.md)')
    assert.doesNotMatch(html, /data-workspace-link|data-browser-link/)
  })

  it('appLinkDecorator derives workspace-ness from the href itself', () => {
    // A relative in-workspace path resolves as a workspace link…
    assert.match(
      renderMarkdownUnsafe('[a](docs/guide.md)', { linkDecorator: appLinkDecorator }),
      /data-workspace-link="true"/,
    )
    // …an external http(s) URL is a browser link.
    assert.match(
      renderMarkdownUnsafe('[b](https://example.com)', { linkDecorator: appLinkDecorator }),
      /data-browser-link="true"/,
    )
    // Both, correctly distinguished, in a single render.
    const html = renderMarkdownUnsafe('[a](docs/guide.md) then [b](https://example.com)', {
      linkDecorator: appLinkDecorator,
    })
    assert.match(html, /docs\/guide\.md"[^>]*data-workspace-link="true"/)
    assert.match(html, /https:\/\/example\.com"[^>]*data-browser-link="true"/)
  })

  it('appLinkDecorator called directly maps href to the right decoration', () => {
    assert.equal(
      appLinkDecorator({ href: 'https://e.com' }),
      ' target="_blank" rel="noopener noreferrer" data-browser-link="true"',
    )
    assert.equal(
      appLinkDecorator({ href: 'src/main.ts', title: 'T' }),
      ' class="workspace-markdown-link" data-workspace-link="true" title="T"',
    )
  })
})
