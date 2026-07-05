/**
 * E2E tests: rendering fidelity and performance regression for large realistic documents.
 *
 * These complement the CommonMark baseline convergence suite
 * (`streaming-convergence.test.ts`) by exercising representative LLM-response
 * documents and asserting that throughput scales linearly — not quadratically —
 * with input size.
 *
 * Run: `npm test` (the file is picked up by the `src/**\/*.test.ts` glob).
 * For an exhaustive character-by-character fidelity sweep set
 * STREAMING_FUZZ_ALL=1, e.g. `STREAMING_FUZZ_ALL=1 npm test`.
 */
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { renderStreamingMarkdown, StreamingMarkdownRenderer, splitForStreaming } from './streaming.ts'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readFixture(name: string): string {
  return readFileSync(resolve(pkgRoot, 'tests/fixtures', name), 'utf8')
}

/** A synthetic LLM response covering all major block types. */
function syntheticLLMResponse(): string {
  const codeBlock = `\`\`\`typescript
import { StreamingMarkdownRenderer } from '@copse/streaming-markdown'

async function streamResponse(url: string, el: HTMLElement) {
  const renderer = new StreamingMarkdownRenderer(el)
  const res = await fetch(url)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let accumulated = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    accumulated += decoder.decode(value, { stream: true })
    renderer.update(accumulated)
  }
}
\`\`\``

  const table = `| Block type | Pending class | Settled element |
| --- | --- | --- |
| Paragraph | \`stream-pending-paragraph\` | \`<p>\` |
| List item | \`stream-pending-list-item\` | \`<li>\` |
| Heading | \`stream-pending-heading\` | \`<h1>…<h6>\` |
| Code fence | \`stream-fence-forming\` | \`<pre><code>\` |
| Table row | \`pending-row\` | \`<tr>\` |`

  return `# Streaming Markdown Architecture

## Overview

The renderer splits incoming text at **block boundaries** — blank lines, newlines,
and block-level markers — and applies two rendering strategies:

- **Committed blocks** are fully rendered as CommonMark HTML
- **The pending tail** is styled with semantic pending classes until the next block boundary arrives

This lets the UI show structured output immediately without waiting for a complete
block, while avoiding the flash of raw markdown syntax like \`**bold**\` or \`# heading\`.

## Implementation

${codeBlock}

## Block types and their pending states

${table}

## Performance characteristics

The DOM emitter maintains three child elements inside the host:

1. \`.stream-complete\` — all committed blocks; only updated when the safe prefix grows
2. \`.stream-forming\` — a forming table or code fence (updated in-place per row/line)
3. \`.stream-pending\` — the current pending tail (replaced on each update)

This means most updates are O(1) in committed-block count: the complete section is
only re-rendered when a new block commits, not on every character.

### Worst case

The string path (\`renderStreamingMarkdown\`) re-renders the full partial string on
every call, making it O(n) per call and O(n²) total for a document of n characters.
Use the DOM emitter for long documents.

## Sanitizer

The renderer outputs **untrusted HTML** — always sanitize at every \`innerHTML\` sink.
The bundled \`sanitizeRenderedMarkdown\` function wraps either the native Sanitizer API
(\`Element.setHTML\`, zero-dependency) or a DOMPurify backend for Node/jsdom:

\`\`\`typescript
import { sanitizeRenderedMarkdown, setSanitizerBackend } from '@copse/streaming-markdown'
import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'

setSanitizerBackend(dompurifyBackend) // once, before first render
el.innerHTML = sanitizeRenderedMarkdown(renderMarkdown(markdown))
\`\`\`

> The DOMPurify backend lives behind its own entry point so bundlers can drop it
> when it's not imported.

## Conformance

The renderer targets CommonMark 0.31.2. See \`docs/ARCHITECTURE.md\` for the
conformance baseline and known divergences.

*Questions or issues? Open a ticket on GitHub.*`
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** The "settled" visible output: committed + any forming section + pending tail. */
function extractDomDisplay(host: HTMLElement): string {
  const parts: string[] = []
  const complete = host.querySelector('.stream-complete')
  if (complete) parts.push(complete.innerHTML)
  const forming = host.querySelector('.stream-forming')
  if (forming instanceof HTMLElement && !forming.hidden) parts.push(forming.innerHTML)
  const pending = host.querySelector('.stream-pending')
  if (pending instanceof HTMLElement && !pending.hidden && pending.innerHTML !== '') {
    parts.push(pending.innerHTML)
  }
  return parts.join('')
}

function freshDomRender(markdown: string): string {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  renderer.update(markdown)
  return extractDomDisplay(host)
}

function streamedDomRender(markdown: string, chunkSize: number): string {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  for (let i = chunkSize; i < markdown.length; i += chunkSize) {
    renderer.update(markdown.slice(0, i))
  }
  renderer.update(markdown)
  return extractDomDisplay(host)
}

/** Cut indices for fidelity sweeps. All positions for short text, sampled for long. */
function cutIndices(text: string): number[] {
  const len = text.length
  if (len <= 512 || process.env['STREAMING_FUZZ_ALL'] === '1') {
    return Array.from({ length: len + 1 }, (_, i) => i)
  }
  const cuts = new Set<number>([0, len])
  for (let i = 0; i < len; i++) {
    if (text[i] === '\n' || i < 64 || i >= len - 64) cuts.add(i)
  }
  const stride = Math.max(1, Math.ceil(len / 200))
  for (let i = 0; i <= len; i += stride) cuts.add(i)
  return [...cuts].sort((a, b) => a - b)
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURES: Record<string, string> = {
  'synthetic-llm-response': syntheticLLMResponse(),
  'terms-of-service': readFixture('terms-of-service-streaming.md'),
}

// ── Fidelity tests ─────────────────────────────────────────────────────────

describe('fidelity: large realistic documents', () => {
  for (const [label, markdown] of Object.entries(FIXTURES)) {
    describe(label, () => {
      it('streaming in fixed chunks converges to a fresh full-document DOM render', () => {
        const baseline = freshDomRender(markdown)
        for (const chunkSize of [1, 8, 64, 256]) {
          const streamed = streamedDomRender(markdown, chunkSize)
          assert.equal(streamed, baseline, `chunk=${String(chunkSize)}`)
        }
      })

      it('streaming at all cut points converges to a fresh full-document DOM render', () => {
        const baseline = freshDomRender(markdown)
        const cuts = cutIndices(markdown)
        const host = document.createElement('div')
        const renderer = new StreamingMarkdownRenderer(host)
        for (const cut of cuts) {
          renderer.update(markdown.slice(0, cut))
        }
        const streamed = extractDomDisplay(host)
        assert.equal(streamed, baseline)
      })

      it('string renderer matches DOM renderer at completion when fully committed', () => {
        if (splitForStreaming(markdown).pending !== '') return
        const domOutput = freshDomRender(markdown)
        const stringOutput = renderStreamingMarkdown(markdown)
        assert.equal(stringOutput, domOutput)
      })
    })
  }
})

// ── Performance regression tests ───────────────────────────────────────────

describe('performance: throughput does not degrade super-linearly', () => {
  /** Median of `reps` timed runs of `fn`. */
  function medianMs(fn: () => void, reps: number): number {
    const times: number[] = []
    for (let i = 0; i < reps; i++) {
      const t = performance.now()
      fn()
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    const mid = Math.floor(times.length / 2)
    return times.length % 2 ? (times[mid] ?? 0) : ((times[mid - 1]! + times[mid]!) / 2)
  }

  function benchDomPath(text: string, chunkSize: number): number {
    return medianMs(() => {
      const host = document.createElement('div')
      const renderer = new StreamingMarkdownRenderer(host)
      for (let i = chunkSize; i < text.length; i += chunkSize) {
        renderer.update(text.slice(0, i))
      }
      renderer.update(text)
    }, 3)
  }

  function benchStringPath(text: string, chunkSize: number): number {
    return medianMs(() => {
      for (let i = chunkSize; i < text.length; i += chunkSize) {
        renderStreamingMarkdown(text.slice(0, i))
      }
      renderStreamingMarkdown(text)
    }, 3)
  }

  /**
   * For the DOM emitter, doubling input should stay well below 5×:
   *   Linear O(n) → ~2×, quadratic O(n²) → ~4×.
   * We use 5× to absorb measurement noise in CI while still catching regressions.
   *
   * The string emitter is O(n²) by design (each call re-renders the full
   * accumulated string), so we only verify its throughput floor, not scaling.
   */
  const DOM_SCALING_THRESHOLD = 5.0

  it('DOM emitter: doubling input size stays below 5× time ratio', () => {
    const base = syntheticLLMResponse()
    const doubled = base + '\n\n' + base
    const chunkSize = 32

    // Warm up — JIT and memory layout settle.
    benchDomPath(base, chunkSize)
    benchDomPath(doubled, chunkSize)

    const tBase = benchDomPath(base, chunkSize)
    const tDoubled = benchDomPath(doubled, chunkSize)

    if (tBase < 1) return // too fast to measure reliably; skip ratio check
    const ratio = tDoubled / tBase
    assert.ok(
      ratio < DOM_SCALING_THRESHOLD,
      `DOM scaling ratio ${ratio.toFixed(2)}× exceeds ${String(DOM_SCALING_THRESHOLD)}× (O(n²) regression? base=${tBase.toFixed(1)}ms doubled=${tDoubled.toFixed(1)}ms)`,
    )
  })

  it('string emitter: throughput on base document is at least 5 KB/s', () => {
    // The string emitter is O(n²) by design — each call re-renders the full
    // accumulated string — so we assert a throughput floor rather than a
    // scaling ratio.
    const text = syntheticLLMResponse()
    const chunkSize = 64
    const bytes = text.length

    benchStringPath(text, chunkSize) // warm up
    const ms = benchStringPath(text, chunkSize)
    const kbps = bytes / ms

    if (ms < 1) return // too fast to measure; skip
    assert.ok(
      kbps >= 5,
      `String throughput ${kbps.toFixed(1)} KB/s is below 5 KB/s floor (${ms.toFixed(1)}ms for ${String(bytes)} chars)`,
    )
  })

  it('DOM emitter: throughput on terms-of-service fixture is at least 5 KB/s', () => {
    const text = readFixture('terms-of-service-streaming.md')
    const chunkSize = 32
    const bytes = text.length

    // Warm up.
    benchDomPath(text, chunkSize)

    const ms = benchDomPath(text, chunkSize)
    const kbps = bytes / ms // chars per ms ≈ KB/s (ASCII)

    assert.ok(
      kbps >= 5,
      `DOM throughput ${kbps.toFixed(1)} KB/s is below 5 KB/s floor (${ms.toFixed(1)}ms for ${String(bytes)} chars)`,
    )
  })
})
