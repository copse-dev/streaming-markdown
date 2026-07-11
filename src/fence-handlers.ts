import { bumpConfigEpoch } from './config-epoch.ts'
import { escapeMermaidHtml } from './escape.ts'
import { mathBlockHtml, syncFormingMathBlockDom } from './math-block.ts'

// The fence-handler registry (#53): the generalization of the mermaid special
// case. A fenced code block whose info-string language has a registered
// {@link FenceHandler} is emitted by that handler instead of the default
// highlighted `<pre><code>` — in the at-rest renderer, the string streaming
// emitter, and the incremental DOM emitter alike. Fences are opaque to the
// block tokenizer, so a handler changes *emission only*; no parsing changes.
//
// This is the same two-phase shape mermaid pioneered: the handler emits inert,
// escaped scaffolding at render time (before the host's sanitizer sink), and a
// separate hydration step — `hydratePendingDiagrams` for mermaid, or a
// host-owned equivalent — upgrades it after sanitization. Scaffolding therefore
// MUST stay inside the sanitizer allowlist (`sanitize.ts`), or the handler's
// author widens it via `setSanitizeExtension`; hydration output injected after
// the sink is the trusted escape hatch (see the mermaid design invariant in
// docs/ARCHITECTURE.md).

/** Class the streaming emitters put on a still-open (forming) fence's root. */
export const FORMING_FENCE_PRE_CLASS = 'stream-fence-forming'

/** Streaming behaviour of a {@link FenceHandler} while its fence is still open. */
export interface FenceHandlerForming {
  /**
   * HTML for the forming fence (string emitter, and the DOM emitter's first
   * paint). Should carry {@link FORMING_FENCE_PRE_CLASS} on its root element so
   * the pending→committed promotion is a class-only change (see the motion
   * contract in docs/ARCHITECTURE.md). `code` is the body streamed so far.
   */
  html(code: string, lang: string): string
  /**
   * Incremental DOM update as more of the body arrives. Must tolerate the
   * container holding foreign content (the fence may have been reclassified
   * from another language mid-stream) — recreate its own scaffolding when its
   * root selector is missing. When omitted, the emitter falls back to
   * sanitizing {@link FenceHandlerForming.html} into the container via
   * `setSanitizedHtml` each update — correct, but a full-subtree replacement
   * per token; provide `sync` for minimal patches. Implementations that write
   * HTML themselves should use `setSanitizedHtml` (not raw `innerHTML`) so
   * they inherit sanitization and Trusted Types support.
   */
  sync?(container: HTMLElement, code: string, lang: string): void
}

/**
 * Pluggable renderer for a fenced code block with a specific info-string
 * language — the seam behind ```` ```mermaid ````-style custom blocks
 * (math, graphviz, vega, …). Register with {@link setFenceHandler}.
 *
 * `render` returns the at-rest HTML for a completed fence. The code is
 * verbatim fence content (trailing newline included when present); the output
 * is later sanitized at the host's sink like all renderer output, so emit only
 * allowlisted tags/attributes or widen the allowlist via `setSanitizeExtension`.
 */
export interface FenceHandler {
  render(code: string, lang: string): string
  forming?: FenceHandlerForming
}

/**
 * The built-in mermaid handler — the reference {@link FenceHandler}. It emits
 * only inert scaffolding (`mermaid-diagram--pending` + `<pre class="mermaid">`);
 * the mermaid library itself stays behind `@copse/streaming-markdown/diagrams/mermaid`
 * and hydrates the scaffolding via `hydratePendingDiagrams` (`mermaid.ts`).
 */
const mermaidFenceHandler: FenceHandler = {
  render(code) {
    const body = escapeMermaidHtml(code.trimEnd())
    return `<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">${body}</pre></div>`
  },
  forming: {
    html(code) {
      const body = escapeMermaidHtml(code)
      return `<div class="mermaid-diagram mermaid-diagram--pending ${FORMING_FENCE_PRE_CLASS}"><pre class="mermaid">${body}</pre></div>`
    },
    sync(container, code) {
      let diagram = container.querySelector<HTMLElement>(
        `.mermaid-diagram.${FORMING_FENCE_PRE_CLASS}`,
      )
      if (!diagram) {
        container.replaceChildren()
        diagram = document.createElement('div')
        diagram.className = `mermaid-diagram mermaid-diagram--pending ${FORMING_FENCE_PRE_CLASS}`
        const pre = document.createElement('pre')
        pre.className = 'mermaid'
        diagram.append(pre)
        container.append(diagram)
      }
      const pre = diagram.querySelector('pre.mermaid')
      if (pre) pre.textContent = code
    },
  },
}

/**
 * The built-in math handler (#70): ```` ```math ```` fences emit the same inert
 * display-math scaffolding as `$$ … $$` blocks (`math-block--pending` +
 * `<pre class="math">`, math-block.ts); the KaTeX backend stays behind
 * `@copse/streaming-markdown/math/katex` and hydrates the scaffolding via
 * `hydratePendingMath` (`math.ts`).
 */
const mathFenceHandler: FenceHandler = {
  render(code) {
    return mathBlockHtml(code.trimEnd())
  },
  forming: {
    html(code) {
      return mathBlockHtml(code, FORMING_FENCE_PRE_CLASS)
    },
    sync(container, code) {
      syncFormingMathBlockDom(container, code, FORMING_FENCE_PRE_CLASS)
    },
  },
}

/**
 * Handler lookup is case-insensitive on the fence language (```` ```MERMAID ````
 * matches like GitHub's), keyed on the first info-string word after the
 * tokenizer's backslash/entity decoding (`fenceInfoLanguage`).
 */
function normalizeFenceLang(lang: string): string {
  return lang.trim().toLowerCase()
}

const fenceHandlers = new Map<string, FenceHandler>([
  ['mermaid', mermaidFenceHandler],
  ['math', mathFenceHandler],
])

/**
 * Register a {@link FenceHandler} for a fence language, replacing any existing
 * one, or pass `null` to remove it (removing `'mermaid'` restores the default
 * highlighted `<pre><code>` for mermaid fences). Set handlers once, before the
 * first render — at-rest and streaming emitters share this registry, so a
 * mid-stream change would render a fence differently across frames.
 */
export function setFenceHandler(lang: string, handler: FenceHandler | null): void {
  const key = normalizeFenceLang(lang)
  if (handler) fenceHandlers.set(key, handler)
  else fenceHandlers.delete(key)
  bumpConfigEpoch()
}

/** The registered {@link FenceHandler} for a fence language, or `null`. */
export function getFenceHandler(lang: string): FenceHandler | null {
  return fenceHandlers.get(normalizeFenceLang(lang)) ?? null
}
