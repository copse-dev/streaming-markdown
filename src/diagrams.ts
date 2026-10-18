/** Default diagram backend: Pele, loaded on the first render. */
export {
  createPeleDiagramRenderer as createDiagramRenderer,
  peleDiagramRenderer as diagramRenderer,
  loadPele as loadDiagramRenderer,
} from './mermaid-pele.ts'
export type { PeleDiagramOptions as DiagramOptions } from './mermaid-pele.ts'
