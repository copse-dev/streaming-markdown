# Diagram rendering

Pele is the default backend at `@copse/streaming-markdown/diagrams`; the explicit
`diagrams/pele` entry is also available. It renders Mermaid fences using the same
`DiagramRenderer` interface as the optional Mermaid.js adapter. Install
`pele@1.6.0` in the host; the core entry never imports it. Diagram hydration
remains opt-in, and Pele loads on the first render.

```ts
import { StreamingMarkdownRenderer } from '@copse/streaming-markdown'
import { diagramRenderer } from '@copse/streaming-markdown/diagrams'
import { sanitizeDiagramSvg } from '@copse/streaming-markdown/sanitizers/dompurify'

const renderer = new StreamingMarkdownRenderer(host, {
  diagramRenderer,
})
renderer.update(markdown)
await renderer.hydrate({ transformSvg: sanitizeDiagramSvg })

// On subsequent stream updates:
renderer.update(nextMarkdown)
await renderer.hydrate({ transformSvg: sanitizeDiagramSvg })
```

Hosts must configure their usual Markdown sanitizer and pass an SVG sanitizer
through `transformSvg` on every hydration call. The demo and example above use
DOMPurify's SVG profile via `sanitizeDiagramSvg`; the Markdown allowlist would
strip drawing elements. Install the optional `dompurify` peer when using this
helper. It returns TrustedHTML where available (CSP must allow DOMPurify's
policy), or a sanitized string otherwise. A host can supply its own SVG sanitizer
and Trusted Types policy through the same hook.

Use `createDiagramRenderer({ fontFamily: 'Inter', limit: 50000 })` from `diagrams` for
host-owned font and resource limits. Load the font before hydration. Each render
gets a unique accessibility ID prefix. Links and images are disabled by this
backend, and no icon resolver or diagram configuration is exposed.

## Local demo

Run `npm run build:demo`, preview `docs/index.html`, select **Diagrams**, and
click **Stream both**. Pele is the default in both panes and is bundled into a
lazy local chunk; no diagram CDN is needed. Use `?diagrams=mermaid` to compare
with the explicit Mermaid.js backend. The build also copies KaTeX JavaScript,
CSS and fonts locally so math renders in static
previews that block third-party requests.

## Colors

Set Pele variables on the diagram container. For example, map these to the host's
light/dark theme tokens:

```css
.mermaid-diagram {
  --pele-bg: #ffffff;
  --pele-fg: #1f1f1f;
  --pele-line: #1f1f1f;
  --pele-surface: #f3f3f3;
  --pele-border: #8a8a8a;
}
```

Colors can change without rendering again. Font changes require rendering again.

## Scope and validation

The real-package tests cover multiple diagram types, source limits, unique IDs,
disabled links/images, successful Markdown hydration, inert error fallback, and
the existing SVG transform hook. The streaming test starts from an open fence,
closes it, hydrates it, and then appends text.

The isolated Mermaid iframe remains an explicit Mermaid.js adapter. The Pele
backend does not alter the parser or enable container-width layout. The existing
renderer interface only receives source text. Pele's layouts differ from Mermaid.js, and arbitrary HTML labels,
JavaScript callbacks and Mermaid theme colors are not supported.

When migrating from Mermaid.js, compare representative diagrams visually:
Pele has its own layout engine and appearance. The package's size gate measures
only this adapter with Pele external; it does not measure Pele's runtime payload.

Upstream documentation: https://pele.run/api, https://pele.run/compatibility,
https://pele.run/security.
