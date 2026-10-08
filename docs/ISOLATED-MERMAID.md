# Isolated Mermaid adapter

The optional adapter runs Mermaid in an opaque iframe with a fixed, deny-by-default
CSP. The parser still emits inert source placeholders. The existing in-document
`diagrams/mermaid` adapter is unchanged. This does not add raw SVG support.

## Build the frame

Bundle a **separate browser entry** as one self-contained IIFE (no external chunks):

```ts
import mermaid from 'mermaid'
import { startMermaidFrame } from '@copse/streaming-markdown/diagrams/mermaid/frame'

startMermaidFrame({ mermaid, theme: 'dark', fontFamily: 'sans-serif' })
```

At build time, pass the exact bundled JavaScript to the Node-only document builder:

```ts
import { buildMermaidFrameHtml } from '@copse/streaming-markdown/diagrams/mermaid/build'

writeFileSync('dist/mermaid-frame.html', buildMermaidFrameHtml(bundle, trustedCss))
```

It embeds the bundle and permits only its SHA-256 hash. Script/style closing tags
are rejected. CSS and JavaScript arguments are trusted build assets, never model
output. Do not modify script bytes after hashing or add external scripts/chunks.
Serve the generated HTML from a fixed host-owned URL. For web deployments, the
parent's `frame-src` must permit that URL; any response CSP must also allow the
hash-pinned bootstrap. The bundled code must not need `eval`.

The document permits inline styles, but no image, font URL, fetch, worker, nested
frame or object sources. It denies forms and base changes. Local SVG shapes/text
remain usable. A `prepare` callback can install **bundled binary FontFace data**
before Mermaid measures labels, without widening `font-src 'none'`.

## Mount frames for closed fences

`mountIsolatedDiagrams` does the mounting for you. Call it after every streaming `update()` (or
once after an at-rest render); it is idempotent:

```ts
import {
  mountIsolatedDiagrams,
  type IsolatedDiagramsOptions,
} from '@copse/streaming-markdown/diagrams/mermaid/isolated'

const diagrams: IsolatedDiagramsOptions = {
  url: '/mermaid-frame.html', // trusted deployment setting, never diagram input
  onSettled(diagram, state) {
    if (state === 'rendered') addControls(diagram) // e.g. zoom / full screen
  },
}

renderer.update(text)
mountIsolatedDiagrams(host, diagrams)

// React
<StreamingMarkdown markdown={text} onUpdate={(_, host) => mountIsolatedDiagrams(host, diagrams)} />
<Markdown markdown={text} onRender={(host) => mountIsolatedDiagrams(host, diagrams)} />
```

Only closed fences get a frame: the forming fence and the streaming tail are skipped because the
renderer still reconciles them, while a closed fence is frozen, so its frame survives later
updates. While a frame renders, the escaped source stays on screen and the frame is held out of
layout; once ready the source is removed and the diagram gets `mermaid-diagram--isolated`. On
failure the frame is disposed and the source stays as the inert fallback. State is recorded in
`data-isolated-diagram` (`pending`, `rendered`, `failed`). Do not also configure a
`diagramRenderer` for the same render.

If a proxy in front of your host mishandles framed HTML documents, fetch the frame document
yourself and pass a `blob:` URL as `url` (the page's `frame-src` must then allow `blob:`): the
frame stays sandboxed to an opaque origin and still enforces its own hash-pinned CSP.

### Lower level: one frame

```ts
import { createMermaidFrame } from '@copse/streaming-markdown/diagrams/mermaid/isolated'

const frame = createMermaidFrame(pre.textContent ?? '', {
  url: '/mermaid-frame.html', // trusted deployment setting, never diagram input
  layoutWidth: pre.clientWidth,
  signal: abortController.signal,
})
pre.replaceChildren(frame.element)
try {
  await frame.ready
} catch {
  frame.dispose()
  // Present an inert textContent fallback owned by the host.
}
```

Keep the handle and call `dispose()` when replacing/unmounting it. Pending work
also cancels on abort or observed DOM removal. `ready` rejects on failure,
invalid replies, cancellation, or a 30-second timeout; handle rejection promptly.
The timeout does not interrupt synchronous Mermaid execution. Expand by rendering
the original source in a **new frame**, never by copying SVG into the parent.
Do not re-run the markdown sanitizer over a mounted frame (iframes are deliberately
not on its allowlist). The host owns mount preservation and final-stream hydration.

Source is bounded to 50,000 characters. The private MessagePort accepts only
finite positive dimensions, capped at 4096. Only the exact parent window can
initialize the child, once. No markup, URLs, or native-operation requests are
returned. The iframe has `allow-scripts`, without `allow-same-origin`, popups,
top navigation or forms. Do not relax its sandbox attributes.

## Host responsibilities and limits

**CSP is resource-load enforcement, not a complete network or navigation firewall.**
The host must block diagram self-navigation separately. Copse does this in Electron's
`will-frame-navigate`, permitting only its exact packaged frame URL, and denies
native APIs to subframes. A plain web iframe cannot offer that same native guard;
web consumers must not claim equivalent navigation/egress containment.

Keep the frame free of preload/native APIs and fetching bridges. Treat all source
as untrusted; keep Mermaid strict security enabled. The package pins `strict` and
source limits independently of the host's theme/font choices. The host remains
responsible for dependency integrity, deployment, accessibility, theme, concurrency,
and CPU/memory limits. No dedicated-process or sandbox-escape guarantee is made.
WebRTC/speculative networking are not claimed to be comprehensively contained.

`tests/mermaid-isolated.e2e.test.ts` uses real Chromium and Mermaid to verify
opaque-origin rendering and zero probe requests for SVG/image, CSS, fonts, fetch,
scripts, nested frames and objects. Copse additionally tests native navigation
blocking and inline/expanded rendering. Run `E2E_REQUIRE_BROWSER=1 npm run test:e2e`
with `CHROMIUM_BIN` pointing at Chromium to make missing browser coverage fail.
