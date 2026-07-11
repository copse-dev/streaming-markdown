import { escapeHtml } from './escape.ts'
import type { CodeHighlighter } from './highlight.ts'

// PROTOTYPE (#lazy-load): the Shiki backend — a second {@link CodeHighlighter},
// sibling of `highlight-hljs.ts`. It is the ONLY module that references `shiki`,
// and lives behind the `@copse/streaming-markdown/highlighters/shiki` subpath, so
// shiki stays out of any bundle that doesn't reference this entry. `shiki` is an
// OPTIONAL peer dependency; every import of it below uses a non-literal specifier
// (the `mermaid-mermaidjs.ts` trick) so the package builds and type-checks even
// when the peer isn't installed.
//
// Two constraints shape this backend:
//
// • **Async seam.** The {@link CodeHighlighter} contract is synchronous
//   string→HTML, but shiki can only initialize asynchronously (engine, grammar
//   and theme modules are dynamic imports). The exported {@link shikiHighlighter}
//   is therefore a stable facade: it renders escaped plain text until
//   {@link loadShiki} resolves, then highlights synchronously against the loaded
//   instance. That is exactly the plain → highlighted upgrade the core already
//   defines for a not-yet-registered backend — `fenceCodeClass` stays stable, so
//   a re-render swaps only the interior of the `<pre><code>` element.
//
// • **Sanitizer compatibility.** Shiki's stock `codeToHtml` emits inline `style`
//   attributes (even its CSS-variables theming does), and the sink sanitizer
//   deliberately strips `style` — widening that allowlist would hand markdown
//   authors arbitrary CSS. Instead this backend renders from `codeToTokensBase`
//   and maps each token's resolved theme color to a *class* (`shiki-<hex>`,
//   plus `shiki-italic`/`shiki-bold`/…), which the existing `class` allowlist
//   already passes. {@link shikiThemeCss} generates the theme's tiny stylesheet
//   (one rule per palette color) for the host to inject once.
//
// It uses shiki's fine-grained core (`shiki/core` + the JavaScript regex engine)
// rather than the batteries-included entry, so the lazy chunk carries only the
// registered grammars and theme — no WASM, no full bundled registry.

/** A themed token from shiki's `codeToTokensBase` (structural, no shiki types). */
interface ShikiToken {
  content: string
  color?: string
  fontStyle?: number
}

/** The slice of a resolved shiki theme this backend reads. */
interface ShikiResolvedTheme {
  fg?: string
  settings?: readonly { settings?: { foreground?: string } }[]
}

/** The slice of the shiki highlighter API this backend uses (avoids a hard type dependency). */
interface ShikiHighlighterLike {
  codeToTokensBase(code: string, options: { lang: string; theme: string }): ShikiToken[][]
  getLoadedLanguages(): string[]
  getTheme(name: string): ShikiResolvedTheme
}

/**
 * A pre-resolved shiki theme registration object (a TextMate theme with a
 * `name`), for hosts that ship a custom theme instead of naming a bundled one.
 */
export interface ShikiThemeRegistration {
  name: string
  [key: string]: unknown
}

/** Options for {@link loadShiki} / {@link installShiki}. */
export interface ShikiOptions {
  /**
   * Theme: a bundled shiki theme name (loaded from `shiki/themes/<name>.mjs`)
   * or a pre-resolved {@link ShikiThemeRegistration}. Default: `'github-dark'`.
   */
  theme?: string | ShikiThemeRegistration
  /**
   * Grammar names to register, each loaded from `shiki/langs/<name>.mjs`.
   * Default: grammars covering the core `KNOWN_LANGUAGES` set. Grammars outside
   * that set still need a matching id in the core to ever be asked for.
   */
  langs?: readonly string[]
}

// Specifiers are held in consts (and built via template literals below) so the
// compiler treats every `import(…)` of shiki as runtime-only — the package
// builds and type-checks without the optional `shiki` peer installed, and
// bundlers still code-split this module into its own chunk.
const SHIKI_CORE_SPECIFIER = 'shiki/core'
const SHIKI_JS_ENGINE_SPECIFIER = 'shiki/engine/javascript'

const DEFAULT_THEME = 'github-dark'

// The grammar modules that cover `KNOWN_LANGUAGES` in `highlight.ts` — keep the
// two in sync (same contract as the hljs grammar list). `shellscript` registers
// the `bash` and `shell` aliases, covering both core ids with one grammar.
const DEFAULT_GRAMMARS: readonly string[] = [
  'typescript',
  'javascript',
  'shellscript',
  'json',
  'python',
  'css',
  'xml',
  'markdown',
  'yaml',
  'rust',
  'go',
  'sql',
]

// Only hex colors become class names (`shiki-f97583`): the token color lands in
// a `class="…"` context, so any other form (`red`, `var(--x)`) is skipped —
// the token then renders bare rather than trusting theme text in markup. Real
// shiki themes use hex throughout. Lowercased on both the token and the
// stylesheet side, since shiki reports `#F97583` in tokens but `#f97583` in
// resolved theme settings.
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/

function normalizeHexColor(color: string | undefined): string | null {
  if (!color) return null
  const normalized = color.toLowerCase()
  return HEX_COLOR_RE.test(normalized) ? normalized : null
}

// shiki's FontStyle bitmask: Italic=1, Bold=2, Underline=4, Strikethrough=8.
const FONT_STYLE_CLASSES: readonly (readonly [number, string, string])[] = [
  [1, 'shiki-italic', 'font-style: italic'],
  [2, 'shiki-bold', 'font-weight: bold'],
  [4, 'shiki-underline', 'text-decoration: underline'],
  [8, 'shiki-strikethrough', 'text-decoration: line-through'],
]

interface LoadedState {
  highlighter: ShikiHighlighterLike
  themeName: string
  /** The theme's default foreground (lowercased) — tokens in it are emitted bare. */
  defaultFg: string | null
  /** Registered language ids + aliases, the guard against KNOWN_LANGUAGES drift. */
  loadedLanguages: ReadonlySet<string>
}

let loaded: LoadedState | null = null
let loadPromise: Promise<CodeHighlighter> | null = null

/**
 * @internal Test seam: drop the loaded shiki instance and the cached load so a
 * suite can exercise the pre-load facade and reload with different options.
 */
export function __resetShikiForTests(): void {
  loaded = null
  loadPromise = null
}

function renderToken(token: ShikiToken, defaultFg: string | null): string {
  const text = escapeHtml(token.content)
  const classes: string[] = []
  const color = normalizeHexColor(token.color)
  if (color && color !== defaultFg) classes.push(`shiki-${color.slice(1)}`)
  const fontStyle = token.fontStyle ?? 0
  for (const [bit, className] of FONT_STYLE_CLASSES) {
    if (fontStyle & bit) classes.push(className)
  }
  // Default-foreground tokens (plain text, whitespace) are emitted bare: the
  // interior stays lean and the host's code-block text color shows through.
  if (classes.length === 0) return text
  return `<span class="${classes.join(' ')}">${text}</span>`
}

function renderTokenLines(
  lines: readonly (readonly ShikiToken[])[],
  defaultFg: string | null,
): string {
  // `codeToTokensBase` splits on newlines and its token contents concatenate
  // back to the input exactly, so joining with '\n' preserves the code verbatim
  // (matching the hljs `.value` contract highlightFenceCode depends on).
  return lines.map((line) => line.map((token) => renderToken(token, defaultFg)).join('')).join('\n')
}

/**
 * Shiki-backed {@link CodeHighlighter}. A stable facade over the async-loading
 * library: before {@link loadShiki} resolves it returns escaped plain text
 * (byte-identical to the core's no-backend fallback), after it highlights
 * synchronously against the loaded instance. Register it via
 * {@link installShiki}, or let {@link loadShiki} do so once loading completes.
 */
export const shikiHighlighter: CodeHighlighter = {
  highlight(code: string, language: string): string {
    const state = loaded
    // Not loaded yet (the async seam), or a drift between KNOWN_LANGUAGES and
    // the registered grammars: escaped plain text. Unlike hljs there is no
    // auto-detect rescue — shiki has none.
    if (!state || !state.loadedLanguages.has(language)) return escapeHtml(code)
    const lines = state.highlighter.codeToTokensBase(code, {
      lang: language,
      theme: state.themeName,
    })
    return renderTokenLines(lines, state.defaultFg)
  },
  highlightAuto(code: string): string {
    // shiki has no language auto-detection, so an empty fence info string stays
    // escaped plain text (hljs guesses here — a documented behavioural mismatch).
    return escapeHtml(code)
  },
}

async function createLoadedState(options?: ShikiOptions): Promise<LoadedState> {
  const theme = options?.theme ?? DEFAULT_THEME
  const themeName = typeof theme === 'string' ? theme : theme.name
  const grammars = options?.langs ?? DEFAULT_GRAMMARS
  const [coreModule, engineModule] = (await Promise.all([
    import(SHIKI_CORE_SPECIFIER),
    import(SHIKI_JS_ENGINE_SPECIFIER),
  ])) as [
    { createHighlighterCore(options: Record<string, unknown>): Promise<unknown> },
    { createJavaScriptRegexEngine(): unknown },
  ]
  const highlighter = (await coreModule.createHighlighterCore({
    themes: [typeof theme === 'string' ? import(`shiki/themes/${theme}.mjs`) : theme],
    langs: grammars.map((name) => import(`shiki/langs/${name}.mjs`)),
    // The JavaScript regex engine: no oniguruma WASM in the chunk, and all the
    // default grammars above are supported by it.
    engine: engineModule.createJavaScriptRegexEngine(),
  })) as ShikiHighlighterLike
  return {
    highlighter,
    themeName,
    defaultFg: normalizeHexColor(highlighter.getTheme(themeName).fg),
    loadedLanguages: new Set(highlighter.getLoadedLanguages()),
  }
}

/**
 * Lazy convenience: import shiki (core + engine + grammars + theme, each a
 * code-split chunk when reached via a dynamic `import('…/highlighters/shiki')`),
 * then register {@link shikiHighlighter}. The first call's options win; later
 * calls reuse the already-loaded instance (idempotent registration, mirroring
 * `loadHighlightjs`). Rejects when the optional `shiki` peer isn't installed.
 */
export function loadShiki(options?: ShikiOptions): Promise<CodeHighlighter> {
  loadPromise ??= createLoadedState(options).then((state) => {
    loaded = state
    return shikiHighlighter
  })
  return loadPromise
}

/**
 * Return the shiki {@link CodeHighlighter} synchronously and start loading the
 * library in the background. Pass the result via `MarkdownConfig.codeHighlighter`:
 * fences render as escaped plain text (with the stable core-resolved `hljs lang-*`
 * class) until the load completes, and a re-render then upgrades them in place.
 * `await loadShiki()` instead to observe load completion or failure — this
 * fire-and-forget form surfaces a missing peer as an unhandled rejection, the
 * async analogue of a failing static `highlight.js` import.
 */
export function installShiki(options?: ShikiOptions): CodeHighlighter {
  void loadShiki(options)
  return shikiHighlighter
}

/**
 * The stylesheet for the loaded theme: one `color` rule per palette foreground
 * (`.shiki-<hex>`) plus the four font-style classes. Inject it once, any way
 * your app ships CSS — it is host-injected style, not sanitized markdown, so it
 * never passes through the sink sanitizer. Returns `''` until {@link loadShiki}
 * has resolved (the theme palette isn't known before then). Tokens in the
 * theme's default foreground are emitted bare, so the code block's base text
 * color stays under the host stylesheet's control.
 */
export function shikiThemeCss(): string {
  const state = loaded
  if (!state) return ''
  const colors = new Set<string>()
  for (const setting of state.highlighter.getTheme(state.themeName).settings ?? []) {
    const color = normalizeHexColor(setting.settings?.foreground)
    if (color && color !== state.defaultFg) colors.add(color)
  }
  const rules = [...colors].sort().map((color) => `.shiki-${color.slice(1)} { color: ${color} }`)
  for (const [, className, declaration] of FONT_STYLE_CLASSES) {
    rules.push(`.${className} { ${declaration} }`)
  }
  return `${rules.join('\n')}\n`
}
