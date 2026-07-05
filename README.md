# @copse/streaming-markdown

A streaming-capable CommonMark renderer with two emitters: a pure string→HTML
function for at-rest rendering, and an incremental DOM renderer that reveals
partial markdown as tokens arrive without flashing raw syntax. Built for
LLM/agent chat UIs, but host-independent.

```bash
npm install @copse/streaming-markdown
```

```ts
import { renderMarkdown, sanitizeRenderedMarkdown } from '@copse/streaming-markdown'

// renderMarkdown returns UNTRUSTED HTML — sanitize at every innerHTML sink.
el.innerHTML = sanitizeRenderedMarkdown(renderMarkdown('# Hi\n\n**bold** and ~~strike~~'))
```

Streaming, syntax highlighting, Mermaid source preparation, and an injectable
`LinkDecorator` for host-specific `<a>` routing are also exported — see the
public surface in [`src/index.ts`](src/index.ts).

## Development

```bash
npm install
npm run typecheck   # tsc (strict, exactOptionalPropertyTypes)
npm test            # node:test via tsx — unit + CommonMark conformance
npm run build       # emit dist/ (ESM JS + .d.ts)
```

## Architecture

Hand-rolled renderer in `renderer.ts`. At-rest rendering routes through
`tokenizeBlocks()` → `renderBlocks()` (`render-blocks.ts`); block/inline tokenizers in
`block-tokenizer.ts`, `inline-emphasis.ts`, and `streaming-split.ts` also drive streaming
hold decisions. It treats the CommonMark spec as the reference for block/inline
structure and grows toward it incrementally (see the conformance baseline in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

## Documentation

The design invariants (sanitize-at-the-sink, package boundary, streaming hold,
raw-HTML policy, …), the two-emitter streaming architecture, and the full
regression/conformance suite are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
