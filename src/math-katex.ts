import { type MathRenderer } from './math.ts'

// The KaTeX backend (#70) — the math analogue of `mermaid-mermaidjs.ts`. It is
// the only module that pulls in `katex`, and lives behind the
// `@copse/streaming-markdown/math/katex` subpath, so the (large) KaTeX library
// is fetched only when a host references this entry. `katex` is an OPTIONAL
// peer dependency: the host installs it (and loads the KaTeX stylesheet/fonts —
// the HTML is unreadable without them), the package never bundles it.
//
//   • static: import { katexMathRenderer } from '@copse/streaming-markdown/math/katex'
//     and pass it via `MarkdownConfig.mathRenderer` (or the hydrate `renderer`
//     option). Pair with `mathSyntax: true` for the prose `$…$` grammar.
//
//   • lazy (fetch the library as its own chunk only when first needed):
//       const { loadKatex } = await import('@copse/streaming-markdown/math/katex')
//       const katex = await loadKatex()
//       new StreamingMarkdownRenderer(host, { mathSyntax: true, mathRenderer: katex })
//       // …update(), then await renderer.hydrate()

/** The slice of the katex API this backend uses (avoids a hard type dependency). */
interface KatexLike {
  renderToString(source: string, options: Record<string, unknown>): string
}

let katexLib: KatexLike | null = null

// The specifier is held in a const so the compiler treats it as a runtime-only
// dynamic import — the package builds and type-checks without the optional
// `katex` peer installed, and bundlers still code-split it into its own chunk.
const KATEX_SPECIFIER = 'katex'
type KatexImporter = () => Promise<unknown>
let importKatex: KatexImporter = () => import(KATEX_SPECIFIER)

/**
 * @internal Test seam. The suite injects a fake module here to exercise the
 * load-and-render path without depending on the optional peer being installed.
 * Passing `null` restores the real importer.
 */
export function __setKatexImporterForTests(fn: KatexImporter | null): void {
  importKatex = fn ?? (() => import(KATEX_SPECIFIER))
  katexLib = null
}

/** Import the katex library (once). */
async function loadKatexLib(): Promise<KatexLike> {
  if (katexLib) return katexLib
  const mod = (await importKatex()) as { default?: KatexLike } & Partial<KatexLike>
  katexLib = (mod.default ?? mod) as KatexLike
  return katexLib
}

/** KaTeX-backed {@link MathRenderer}. Pass it via `MarkdownConfig.mathRenderer` or {@link loadKatex}. */
export const katexMathRenderer: MathRenderer = {
  async render(source: string, { displayMode }) {
    const lib = await loadKatexLib()
    // throwOnError:false — invalid TeX renders as visible red-tinted source
    // instead of rejecting the whole expression; trust:false — no \href/\html*
    // commands, since this HTML is injected after the sink sanitizer.
    const html = lib.renderToString(source, {
      displayMode,
      throwOnError: false,
      trust: false,
    })
    return { html }
  },
}

/**
 * Return the KaTeX {@link MathRenderer} (the library still loads lazily on the
 * first {@link katexMathRenderer.render}). When called through a dynamic
 * `import('.../math/katex')`, the katex library is a code-split chunk fetched at
 * this point. Pass the result via `MarkdownConfig.mathRenderer` (with
 * `mathSyntax: true` for the prose grammar) or the hydrate `renderer` option;
 * equivalent to importing {@link katexMathRenderer} directly.
 */
export function loadKatex(): Promise<MathRenderer> {
  return Promise.resolve(katexMathRenderer)
}
