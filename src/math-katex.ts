import { type MathRenderer, setMathRenderer } from './math.ts'

// The KaTeX backend (#70) — the math analogue of `mermaid-mermaidjs.ts`. It is
// the only module that pulls in `katex`, and lives behind the
// `@copse/streaming-markdown/math/katex` subpath, so the (large) KaTeX library
// is fetched only when a host references this entry. `katex` is an OPTIONAL
// peer dependency: the host installs it (and loads the KaTeX stylesheet/fonts —
// the HTML is unreadable without them), the package never bundles it.
//
//   • static (KaTeX ready from first hydration):
//       import { setMathRenderer } from '@copse/streaming-markdown'
//       import { katexMathRenderer } from '@copse/streaming-markdown/math/katex'
//       setMathRenderer(katexMathRenderer)
//
//   • lazy (fetch the library as its own chunk only when first needed):
//       const { loadKatex } = await import('@copse/streaming-markdown/math/katex')
//       await loadKatex()
//       await hydratePendingMath(messageEl)

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

/** KaTeX-backed {@link MathRenderer}. Register it via {@link installKatex}. */
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
 * Register the KaTeX backend synchronously (the library still loads lazily on
 * first render). Registration also activates the `$…$`-style prose math grammar
 * via `setMathRenderer` (#78) — this one call is the whole opt-in.
 */
export function installKatex(): MathRenderer {
  setMathRenderer(katexMathRenderer)
  return katexMathRenderer
}

/**
 * Lazy convenience: register the KaTeX backend (activating the prose math
 * grammar, #78). When called through a dynamic `import('.../math/katex')`, the
 * katex library is a code-split chunk fetched at this point (or on the first
 * {@link katexMathRenderer.render}). Idempotent.
 */
export function loadKatex(): Promise<MathRenderer> {
  return Promise.resolve(installKatex())
}
