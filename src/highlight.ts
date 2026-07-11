import { activeConfig } from './config.ts'
import { escapeHtml } from './escape.ts'

// PROTOTYPE (#lazy-load): this module is the *core* of syntax highlighting and
// deliberately imports **no** highlight.js code. highlight.js (core + a dozen
// language grammars) is the single heaviest dependency in the package, and
// because `render-blocks.ts` pulls this module in, it used to land in every
// consumer's bundle — even one that never renders a code fence.
//
// The heavy grammars now live behind a pluggable {@link CodeHighlighter} backend
// (`highlight-hljs.ts`), mirroring the pluggable-sanitizer-backend split. Until a
// backend is registered (`setCodeHighlighter`, or the lazy `loadHighlightjs()`),
// fenced code renders as escaped plain text with the correct `hljs lang-*` class,
// and upgrades to token spans once the backend arrives. Language *resolution*
// (aliases + the known-language set) stays here because it is cheap string work
// and keeps `fenceCodeClass` stable across the plain → highlighted upgrade, so a
// streaming re-render never has to churn the element's className.

/**
 * Pluggable syntax highlighter. A backend receives already-resolved input from
 * the core: `highlight` is called with a language id the core has confirmed the
 * backend registered, and `highlightAuto` is called only for an empty fence info
 * string. Both return an HTML token string (highlight.js `.value`-shaped).
 *
 * Register one with {@link setCodeHighlighter}, or lazily via `loadHighlightjs()`
 * / `installHighlightjs()` from `@copse/streaming-markdown/highlighters/highlightjs`.
 */
export interface CodeHighlighter {
  /** Highlight `code` as `language` (a resolved id from {@link KNOWN_LANGUAGES}). */
  highlight(code: string, language: string): string
  /** Auto-detect and highlight `code` (used only for an empty fence info string). */
  highlightAuto(code: string): string
}

/**
 * Language ids the core knows how to resolve to. This MUST stay in sync with the
 * grammars the {@link CodeHighlighter} backends register (`highlight-hljs.ts`,
 * `highlight-shiki.ts`) — the core owns it so `fenceCodeClass` resolves
 * `ts → typescript` before the backend has loaded, giving a stable class across
 * the plain → highlighted swap.
 */
export const KNOWN_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'javascript',
  'bash',
  'shell',
  'json',
  'python',
  'css',
  'xml',
  'markdown',
  'yaml',
  'rust',
  'go',
  'sql',
])

/** Map common fence info strings to highlight.js language ids. */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  zsh: 'bash',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  html: 'xml',
  htm: 'xml',
  rs: 'rust',
  text: 'plaintext',
  plaintext: 'plaintext',
}

/** Resolve a fence info string to a known language id, or `null` (plain/auto). */
function resolveLanguage(lang: string): string | null {
  const key = lang.trim().toLowerCase()
  if (!key) return null
  const resolved = LANG_ALIASES[key] ?? key
  if (resolved === 'plaintext') return null
  return KNOWN_LANGUAGES.has(resolved) ? resolved : null
}

/**
 * The {@link CodeHighlighter} configured for the current render (`null` when none,
 * i.e. escaped-plain-text fallback). Set it per render via
 * `MarkdownConfig.codeHighlighter` — obtain a backend from its `load*` entry
 * (`@copse/streaming-markdown/highlighters/highlightjs` or `.../shiki`).
 */
export function getCodeHighlighter(): CodeHighlighter | null {
  return activeConfig().codeHighlighter ?? null
}

/**
 * Highlight fenced code for HTML injection. With no backend registered, falls
 * back to escaped plain text (safe, and the pre-highlight state a streaming UI
 * shows while the grammar chunk loads); with a backend, delegates to it. The code
 * is rendered verbatim — leading/trailing blank lines and the first line's
 * indentation are preserved (#598); only the block-final newline is dropped for
 * display (the fence parser already omits it).
 */
export function highlightFenceCode(code: string, lang: string): string {
  if (code === '') return ''
  // Blank-only fences (only newlines/spaces) are preserved exactly rather than
  // fed to the highlighter, which would otherwise collapse or mis-detect them.
  if (code.trim() === '') return escapeHtml(code)

  const highlighter = activeConfig().codeHighlighter
  const language = resolveLanguage(lang)

  // No backend yet: plain-text fallback. The `hljs lang-*` class is still applied
  // by `fenceCodeClass`, so a later `setCodeHighlighter` + re-render upgrades the
  // interior to token spans without changing the surrounding element.
  if (!highlighter) return escapeHtml(code)

  if (language) return highlighter.highlight(code, language)
  if (!lang.trim()) return highlighter.highlightAuto(code)
  return escapeHtml(code)
}

export function fenceCodeClass(lang: string): string {
  const language = resolveLanguage(lang)
  const label = language ?? (lang.trim() ? lang.trim().toLowerCase() : 'text')
  // The info string is entity-decoded, so an unrecognized language falls back to
  // attacker-controlled text. Escape it before it lands in a `class="…"` context
  // in the string emitter (the DOM path assigns `.className`, which can't break
  // out). Recognized languages are already safe hljs ids, but escaping is a no-op
  // for them.
  return `hljs lang-${escapeHtml(label)}`
}

/**
 * Undo app-specific fenced-code decoration for CommonMark conformance
 * comparison (the code analogue of `stripAppLinkAttributes`): drop
 * highlight.js token spans, map `hljs lang-x` to the spec's `language-x`
 * (dropping the class entirely for the empty-info `lang-text` fallback), and
 * restore the block-final newline the app trims for display. Structural
 * differences in the code text itself still register as failures.
 */
export function stripAppCodeDecorations(html: string): string {
  return html.replace(
    /<code class="hljs lang-([^"]*)">([\s\S]*?)<\/code>/g,
    (_m, lang: string, body: string) => {
      const text = body.replace(/<span[^>]*>|<\/span>/g, '')
      const classAttr = lang === 'text' ? '' : ` class="language-${lang}"`
      const content = text === '' || text.endsWith('\n') ? text : `${text}\n`
      return `<code${classAttr}>${content}</code>`
    },
  )
}
