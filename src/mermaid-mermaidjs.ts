import { type DiagramRenderer, setDiagramRenderer } from './mermaid.ts'

// PROTOTYPE (#lazy-load): the mermaid backend — the diagram analogue of
// `highlight-hljs.ts`. It is the only module that pulls in `mermaid`, and lives
// behind the `@copse/streaming-markdown/diagrams/mermaid` subpath, so the (large)
// mermaid library is fetched only when a host references this entry. `mermaid` is
// an OPTIONAL peer dependency: the host installs it, the package never bundles it.
//
//   • static (mermaid ready from first hydration):
//       import { setDiagramRenderer } from '@copse/streaming-markdown'
//       import { mermaidDiagramRenderer } from '@copse/streaming-markdown/diagrams/mermaid'
//       setDiagramRenderer(mermaidDiagramRenderer)
//
//   • lazy (fetch the library as its own chunk only when first needed):
//       const { loadMermaid } = await import('@copse/streaming-markdown/diagrams/mermaid')
//       await loadMermaid()
//       await hydratePendingDiagrams(messageEl)

/** The slice of the mermaid API this backend uses (avoids a hard type dependency). */
interface MermaidLike {
  initialize(config: Record<string, unknown>): void
  render(id: string, source: string): Promise<{ svg: string }>
}

let mermaidLib: MermaidLike | null = null
let diagramSeq = 0

// The specifier is held in a const so the compiler treats it as a runtime-only
// dynamic import — the package builds and type-checks without the optional
// `mermaid` peer installed, and bundlers still code-split it into its own chunk.
const MERMAID_SPECIFIER = 'mermaid'
type MermaidImporter = () => Promise<unknown>
let importMermaid: MermaidImporter = () => import(MERMAID_SPECIFIER)

/**
 * @internal Test seam. The real mermaid library needs a browser-grade DOM and
 * can't render under Node/jsdom, so the suite injects a fake module here to
 * exercise the load-and-render path. Passing `null` restores the real importer.
 */
export function __setMermaidImporterForTests(fn: MermaidImporter | null): void {
  importMermaid = fn ?? (() => import(MERMAID_SPECIFIER))
  mermaidLib = null
}

/** Import and one-time-initialize the mermaid library. */
async function loadMermaidLib(): Promise<MermaidLike> {
  if (mermaidLib) return mermaidLib
  const mod = (await importMermaid()) as { default?: MermaidLike } & Partial<MermaidLike>
  const lib = (mod.default ?? mod) as MermaidLike
  // startOnLoad:false — hydration is driven explicitly by hydratePendingDiagrams,
  // never by mermaid's global DOM scan.
  lib.initialize({ startOnLoad: false })
  mermaidLib = lib
  return lib
}

/** Mermaid-backed {@link DiagramRenderer}. Register it via {@link installMermaid}. */
export const mermaidDiagramRenderer: DiagramRenderer = {
  async render(source: string) {
    const lib = await loadMermaidLib()
    diagramSeq += 1
    const { svg } = await lib.render(`smd-mermaid-${String(diagramSeq)}`, source)
    return { svg }
  },
}

/** Register the mermaid backend synchronously (the library still loads lazily on first render). */
export function installMermaid(): DiagramRenderer {
  setDiagramRenderer(mermaidDiagramRenderer)
  return mermaidDiagramRenderer
}

/**
 * Lazy convenience: register the mermaid backend. When called through a dynamic
 * `import('.../diagrams/mermaid')`, the mermaid library is a code-split chunk
 * fetched at this point (or on the first {@link mermaidDiagramRenderer.render}).
 * Idempotent.
 */
export function loadMermaid(): Promise<DiagramRenderer> {
  return Promise.resolve(installMermaid())
}
