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

/** Mermaid's built-in themes, the only values a render request may select. */
export const MERMAID_THEMES = ['default', 'dark', 'forest', 'neutral'] as const
export type MermaidTheme = (typeof MERMAID_THEMES)[number]

/** Upper bound on font bytes a host may hand the frame with one render request. */
export const MAX_FONT_BYTES = 4 * 1024 * 1024

// A CSS font-family *list* (Mermaid writes it into the diagram's own CSS): names, spaces, commas,
// hyphens and quotes only — nothing that can end a declaration or open a url().
const FONT_FAMILY_LIST = /^[\w ,'"-]{1,200}$/
// One family name for a FontFace registration.
const FONT_FAMILY_NAME = /^[\w -]{1,100}$/

/** A font installed in the frame from bytes, so the frame's `font-src 'none'` never widens. */
export interface FrameFont {
  family: string
  data: ArrayBuffer
}

/**
 * One render request from the host. Only `source` is required; the rest is per-render
 * presentation. Optional fields that fail validation are dropped, never forwarded, so a malformed
 * request renders with the frame's defaults instead of reaching Mermaid's configuration.
 */
export interface RenderRequest {
  source: string
  theme?: MermaidTheme
  fontFamily?: string
  font?: FrameFont
}

function own(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

function parseFont(value: unknown): FrameFont | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const family = own(value, 'family')
  const data = own(value, 'data')
  if (typeof family !== 'string' || !FONT_FAMILY_NAME.test(family)) return undefined
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > MAX_FONT_BYTES)
    return undefined
  return { family, data }
}

export function parseRenderRequest(value: unknown): RenderRequest | null {
  if (typeof value !== 'object' || value === null) return null
  if (own(value, 'type') !== 'render') return null
  const source = own(value, 'source')
  if (typeof source !== 'string' || source.length > MAX_DIAGRAM_SOURCE_LENGTH) return null
  const request: RenderRequest = { source }
  const theme = own(value, 'theme')
  if ((MERMAID_THEMES as readonly unknown[]).includes(theme)) request.theme = theme as MermaidTheme
  const fontFamily = own(value, 'fontFamily')
  if (typeof fontFamily === 'string' && FONT_FAMILY_LIST.test(fontFamily))
    request.fontFamily = fontFamily
  const font = parseFont(own(value, 'font'))
  if (font) request.font = font
  return request
}

export function parseDiagramSource(value: unknown): string | null {
  return parseRenderRequest(value)?.source ?? null
}
