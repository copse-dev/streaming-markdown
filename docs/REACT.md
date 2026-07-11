# Using `@copse/streaming-markdown` with React

The core is framework-agnostic on purpose, so there is no React dependency to
install. Wrapping it for React is a ~10-line pattern: one component for at-rest
markdown and one that drives the **incremental DOM** renderer (it patches the
committed tree per token — it does *not* re-render the whole string on every
chunk, which is the thing that makes naive `react-markdown`-in-a-loop janky).

> A first-party `@copse/streaming-markdown/react` subpath is planned
> ([#156](https://github.com/copse-dev/streaming-markdown/issues/156)). Until it
> lands, copy the components below — they are the exact wrappers it will provide.

## At rest

`renderMarkdown` returns sanitized, `innerHTML`-ready HTML, so the component is a
memoized `dangerouslySetInnerHTML`:

```tsx
import { useMemo } from 'react'
import { renderMarkdown } from '@copse/streaming-markdown'

export function Markdown({ content }: { content: string }) {
  // renderMarkdown output is already sanitized (fail-closed) — safe for dSIH.
  const html = useMemo(() => renderMarkdown(content), [content])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
```

`renderMarkdown` builds a DOM to sanitize, so it needs a sanitizer backend — the
browser's native Sanitizer API by default, or a registered one such as
[`…/sanitizers/dompurify`](EXTENDING.md). Register it once at app startup.

## Streaming

Hold the growing text in state and feed it to a single long-lived
`StreamingMarkdownRenderer`; the renderer owns the `<div>`'s children, React owns
the `<div>` itself (the standard "React manages the node, a library manages its
contents" escape hatch — keep the element empty in JSX so React never fights it):

```tsx
import { useEffect, useRef } from 'react'
import {
  StreamingMarkdownRenderer,
  type StreamingMarkdownOptions,
} from '@copse/streaming-markdown'

export function StreamingMarkdown({
  content,
  options,
}: {
  content: string
  options?: StreamingMarkdownOptions
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<StreamingMarkdownRenderer | null>(null)

  // Create the renderer once. Per-render policy options (htmlPolicy, scheme
  // allowlist, …) are captured at construction, matching the library's instance
  // model — change `options` by remounting (e.g. a React `key`), not in place.
  useEffect(() => {
    if (!hostRef.current) return
    rendererRef.current = new StreamingMarkdownRenderer(hostRef.current, options)
    const host = hostRef.current
    return () => {
      rendererRef.current = null
      host.replaceChildren()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- construct once
  }, [])

  // Re-feed the full accumulated text on every change; the renderer diffs it and
  // patches only the settled tail — O(delta), not O(document).
  useEffect(() => {
    rendererRef.current?.update(content)
  }, [content])

  return <div className="markdown" ref={hostRef} />
}
```

Drive it from whatever produces tokens:

```tsx
function Chat({ stream }: { stream: AsyncIterable<string> }) {
  const [text, setText] = useState('')
  useEffect(() => {
    let acc = ''
    ;(async () => {
      for await (const chunk of stream) {
        acc += chunk
        setText(acc) // one state update per chunk; the renderer does the rest
      }
    })()
  }, [stream])
  return <StreamingMarkdown content={text} />
}
```

## Server rendering

`StreamingMarkdownRenderer` needs a DOM, so it is **client-only** — render the
at-rest markup on the server and let the streaming component take over on the
client. Two options for the server pass:

- Register a Node sanitizer backend (`…/sanitizers/dompurify` with a DOM shim such
  as `jsdom`) at startup and use the `<Markdown>` component above unchanged.
- Or use the DOM-free `renderMarkdownUnsafe` and sanitize it yourself before it
  reaches `dangerouslySetInnerHTML` — `renderMarkdownUnsafe` returns **untrusted**
  HTML, so never hand its output to a sink without `sanitizeRenderedMarkdown`.

The streaming component renders an empty `<div>` on the server (it hydrates and
starts patching on mount), so pair it with an at-rest server render of the same
content if you want first-paint markup.

## Migrating from `react-markdown`

The shapes line up closely:

```tsx
// react-markdown
<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>

// @copse/streaming-markdown — GFM (tables, task lists, strikethrough,
// autolinks, footnotes) is built in, no plugin array
<Markdown content={content} />
```

For a chat UI that streams, swap the re-render-per-token `<ReactMarkdown>` for
`<StreamingMarkdown content={accumulatedText} />` and delete the memoization
gymnastics — the incremental renderer is the memoization.

Component-level overrides (react-markdown's `components` prop) map to the
library's extension seams — [`setLinkDecorator`, `setFenceHandler`,
`setCodeHighlighter`, inline passes](EXTENDING.md) — configured once rather than
per-render. The planned first-party wrapper ([#156](https://github.com/copse-dev/streaming-markdown/issues/156))
will expose these as props.
