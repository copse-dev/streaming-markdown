// The entire capability surface of a diagram frame: never return markup, URLs,
// or native-operation requests from an untrusted rendering context.
export const MAX_DIAGRAM_SOURCE_LENGTH = 50_000
export const MAX_DIAGRAM_DIMENSION = 4096

export interface DiagramSize {
  width: number
  height: number
}

export function parseDiagramSize(value: unknown): DiagramSize | null {
  if (typeof value !== 'object' || value === null) return null
  if (!Object.hasOwn(value, 'type') || Reflect.get(value, 'type') !== 'rendered') return null
  if (!Object.hasOwn(value, 'width') || !Object.hasOwn(value, 'height')) return null
  const width: unknown = Reflect.get(value, 'width')
  const height: unknown = Reflect.get(value, 'height')
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return null
  return {
    width: Math.min(width, MAX_DIAGRAM_DIMENSION),
    height: Math.min(height, MAX_DIAGRAM_DIMENSION),
  }
}

export function parseDiagramSource(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  if (!Object.hasOwn(value, 'type') || Reflect.get(value, 'type') !== 'render') return null
  const source: unknown = Object.hasOwn(value, 'source') ? Reflect.get(value, 'source') : null
  return typeof source === 'string' && source.length <= MAX_DIAGRAM_SOURCE_LENGTH ? source : null
}
