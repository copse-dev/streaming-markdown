# Using `@copse/streaming-markdown` with React

First-party React bindings ship as the `@copse/streaming-markdown/react` subpath.
React is an **optional peer dependency** — this subpath is the only module that
imports it, the agnostic core never pulls it in, so a host that never imports
`/react` pays zero React bytes.

Two components mirror the core's two rendering paths:

- **`<Markdown>`** — at-rest render of a complete document (`renderMarkdown`),
  SSR-safe.
- **`<StreamingMarkdown>`** — the incremental DOM path
  (`StreamingMarkdownRenderer.update()`), which patches the committed tree per
  token instead of re-rendering the whole string on every chunk (the thing that
  makes naive `react-markdown`-in-a-loop janky).

Neither asks you to hand-roll `useEffect`/`useRef` wiring or reach for
`dangerouslySetInnerHTML`: each component owns its DOM node and routes every
write through the sanitized sink internally.

```bash
npm install @copse/streaming-markdown react react-dom
```

## At rest

Pass the source as the `markdown` prop (or as a single string child):

```tsx
import { Markdown } from '@copse/streaming-markdown/react'

export function Message({ content }: { content: string }) {
  return <Markdown markdown={content} className="streaming-markdown" />
}
```

`renderMarkdown` builds a DOM to sanitize, so it needs a sanitizer backend — the
browser's native Sanitizer API by default, or a registered one such as
[`…/sanitizers/dompurify`](EXTENDING.md). Register it once at app startup (in the
browser the native default needs nothing).

The component owns its node: after the first paint a layout effect takes
ownership and drives every subsequent update through `setSanitizedHtml`, so a
changing `markdown` prop never triggers a raw `innerHTML` write.

## Streaming

Hold the growing text in state and pass it as `markdown`; the component keeps a
single long-lived `StreamingMarkdownRenderer` bound to its node and calls
`renderer.update()` on each change — the incremental emitter converges the
existing subtree, so this is **not** a re-render per token.

```tsx
import { StreamingMarkdown } from '@copse/streaming-markdown/react'

export function Chat({ text }: { text: string }) {
  return <StreamingMarkdown markdown={text} className="streaming-markdown" />
}
```

Drive the `text` state from whatever produces tokens:

```tsx
import { useEffect, useState } from 'react'

function StreamedMessage({ stream }: { stream: AsyncIterable<string> }) {
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
  return <StreamingMarkdown markdown={text} />
}
```

To hydrate lazy math/diagram backends as the stream lands them, use the
`onUpdate` prop — it fires after each `update()` with the live renderer:

```tsx
<StreamingMarkdown
  markdown={text}
  config={{ mathRenderer, diagramRenderer }}
  onUpdate={(renderer) => void renderer.hydrate()}
/>
```

## Props

Both components accept, in addition to standard container attributes
(`className`, `style`, `id`, …):

| Prop      | Type                                          | Notes |
| --------- | --------------------------------------------- | ----- |
| `markdown`| `string`                                      | The source text. On `<StreamingMarkdown>` it grows as tokens arrive. `<Markdown>` also accepts a single string child instead. |
| `config`  | `MarkdownConfig`                              | Per-instance settings — `htmlPolicy`, scheme allowlist, `linkDecorator`, `fenceHandlers`, `codeHighlighter`, `mathSyntax`, CJK, `trustedTypesPolicy`, `sanitizerBackend`, … Two components with different `config` coexist without interfering. |
| `as`      | `ElementType`                                 | Container element/component. Defaults to `'div'`. |
| `onUpdate`| `(renderer: StreamingMarkdownRenderer) => void`| `<StreamingMarkdown>` only. Called after each `update()`. |

`config` is captured when the underlying renderer is constructed, so
`<StreamingMarkdown>` **re-creates** its renderer when the `config` prop identity
changes — pass a stable/memoized object to avoid needless re-creation.

Under [Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API),
supply a policy via `config.trustedTypesPolicy` — see
[Trusted Types in `docs/EXTENDING.md`](EXTENDING.md#trusted-types).

## Server rendering

`<Markdown>` is SSR-safe: on the server (and the client's hydration pass) it
emits the sanitized HTML via `dangerouslySetInnerHTML` **inside the component**,
so there is real server markup and hydration matches; after mount a layout effect
takes over the node and every later write goes through `setSanitizedHtml`. On the
server, register a Node sanitizer backend once at startup
(`…/sanitizers/dompurify` with a DOM shim such as `jsdom`), or pass one as
`config.sanitizerBackend`.

`<StreamingMarkdown>` is **client-only** — streaming is inherently a client
concern. It renders an empty container on the server and starts patching on
mount (an empty `<div>` on both sides, so no hydration mismatch). Pair it with an
at-rest `<Markdown>` server render of the same content if you want first-paint
markup.

## Migrating from `react-markdown`

The shapes line up closely:

```tsx
// react-markdown
<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>

// @copse/streaming-markdown/react — GFM (tables, task lists, strikethrough,
// autolinks, footnotes) is built in, no plugin array
<Markdown markdown={content} />
```

For a chat UI that streams, swap the re-render-per-token `<ReactMarkdown>` for
`<StreamingMarkdown markdown={accumulatedText} />` and delete the memoization
gymnastics — the incremental renderer is the memoization.

Component-level overrides (react-markdown's `components` prop) map to the
library's extension seams — the [`linkDecorator`, `fenceHandlers`,
`codeHighlighter`, `inlinePasses`](EXTENDING.md) `MarkdownConfig` fields — passed
through the `config` prop.
