import type { HydrateDiagramsOptions, hydratePendingDiagrams } from '../src/mermaid.ts'

export function createDiagramPreviews(options: {
  hydrate: typeof hydratePendingDiagrams
  renderer: HydrateDiagramsOptions['renderer']
  transformSvg: HydrateDiagramsOptions['transformSvg']
}): { update(root: Element): void }
export function removeDiagramPreviews(root: Element): void
