// React wrapper (#156). jsdom + react-dom/client for the client mount path,
// react-dom/server (`renderToStaticMarkup`) for the SSR-markup assertion. The
// setup import installs jsdom DOM globals plus the DOMPurify sanitizer backend
// that `renderMarkdown` needs (there is no native Sanitizer in jsdom).
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { Markdown, StreamingMarkdown } from './react.tsx'

/** Mount `element` into a fresh container and flush synchronously (effects included). */
function mount(element: Parameters<Root['render']>[0]): { container: HTMLElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => root.render(element))
  return { container, root }
}

describe('<Markdown> (at-rest)', () => {
  it('renders inline markdown into the container', () => {
    const { container, root } = mount(<Markdown markdown="**bold**" />)
    assert.match(container.innerHTML, /<strong>bold<\/strong>/)
    flushSync(() => root.unmount())
  })

  it('honors a per-instance config (linkDecorator adds attributes)', () => {
    const { container, root } = mount(
      <Markdown
        markdown="[x](https://example.com)"
        config={{ linkDecorator: () => ' target="_blank" rel="noopener noreferrer"' }}
      />,
    )
    assert.match(container.innerHTML, /<a[^>]*href="https:\/\/example\.com"[^>]*>/)
    assert.match(container.innerHTML, /target="_blank"/)
    flushSync(() => root.unmount())
  })

  it('re-renders when the markdown prop changes (effect takes over the node)', () => {
    const { container, root } = mount(<Markdown markdown="# First" />)
    assert.match(container.innerHTML, /<h1>First<\/h1>/)
    flushSync(() => root.render(<Markdown markdown="# Second" />))
    assert.match(container.innerHTML, /<h1>Second<\/h1>/)
    assert.doesNotMatch(container.innerHTML, /First/)
    flushSync(() => root.unmount())
  })
})

describe('<Markdown> SSR', () => {
  it('emits sanitized server markup via renderToStaticMarkup', () => {
    const html = renderToStaticMarkup(<Markdown markdown="# Hi" />)
    assert.match(html, /<h1>Hi<\/h1>/)
  })
})

describe('<StreamingMarkdown> (incremental)', () => {
  const md1 = '# Title\n\nAlpha paragraph.\n\n'
  const md2 = '# Title\n\nAlpha paragraph.\n\nBeta paragraph.\n\n'

  it('drives update() incrementally and converges to a full render', () => {
    const { container, root } = mount(<StreamingMarkdown markdown={md1} />)
    const host = container.firstElementChild as HTMLElement
    const complete = host.querySelector('.stream-complete') as HTMLElement

    assert.match(complete.innerHTML, /<h1>Title<\/h1>/)
    assert.doesNotMatch(complete.innerHTML, /Beta/)
    const lengthAfterFirst = complete.innerHTML.length

    // Re-render with a longer prop — the SAME host/renderer must grow in place.
    flushSync(() => root.render(<StreamingMarkdown markdown={md2} />))
    assert.equal(
      host.querySelector('.stream-complete'),
      complete,
      'the .stream-complete host is reused across re-renders (no per-token remount)',
    )
    assert.ok(complete.innerHTML.length > lengthAfterFirst, 'committed DOM grew')
    assert.match(complete.innerHTML, /Beta paragraph\./)

    // Converges to a fresh, from-scratch renderer of the same final text.
    const fresh = document.createElement('div')
    new StreamingMarkdownRenderer(fresh).update(md2)
    assert.equal(
      complete.innerHTML,
      (fresh.querySelector('.stream-complete') as HTMLElement).innerHTML,
    )
    flushSync(() => root.unmount())
  })

  it('honors a per-instance config', () => {
    const { container, root } = mount(
      <StreamingMarkdown
        markdown={'[x](https://example.com)\n\n'}
        config={{ linkDecorator: () => ' target="_blank" rel="noopener noreferrer"' }}
      />,
    )
    const host = container.firstElementChild as HTMLElement
    assert.match(host.innerHTML, /target="_blank"/)
    flushSync(() => root.unmount())
  })
})
