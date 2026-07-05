import { decodeEscapedHref } from './escape.ts'

/** A raw `<img>` tag the renderer found in prose, with its parsed attributes. */
export interface RawImageTag {
  /** The verbatim tag text as it appeared (may be an escaped `&lt;img …&gt;` form). */
  tag: string
  /** Lower-cased attribute names → values, entity/percent-decoded. */
  attrs: Record<string, string>
}

/**
 * Host hook for raw `<img>` tags. The core renderer is image-agnostic: it escapes
 * raw HTML, so by default every `<img>` is left untouched (and thus escaped like
 * any other tag). A host that wants to allow specific images (e.g. resolving an
 * app-specific artifact URL to an inert placeholder) injects a renderer via
 * {@link setRawImageRenderer}; return the replacement HTML, or `null` to leave the
 * tag for the default escaping. Whatever the host emits still passes through
 * `sanitizeRenderedMarkdown` — widen its allowlist via `setSanitizeExtension`.
 */
export type RawImageRenderer = (img: RawImageTag) => string | null

let activeRawImageRenderer: RawImageRenderer | null = null

/** Inject a host {@link RawImageRenderer}; pass `null` to restore the default (escape all images). */
export function setRawImageRenderer(renderer: RawImageRenderer | null): void {
  activeRawImageRenderer = renderer
}

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const decodedTag = decodeEscapedHref(tag)
  for (const match of decodedTag.matchAll(/\b([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1]
    if (name === undefined) continue
    attrs[name.toLowerCase()] = match[2] ?? match[3] ?? ''
  }
  return attrs
}

const RAW_IMAGE_RE = /(?:<img\b[\s\S]*?\/?>|&lt;img\b[\s\S]*?\/?&gt;)/gi

// Interlinear-annotation anchors (U+FFF9 / U+FFFB): control chars that never
// appear in prose and are inert to the inline renderer / escaper, so a
// placeholder can hold the renderer's spot while the surrounding text is
// inline-rendered and escaped.
const PLACEHOLDER_OPEN = '￹'
const PLACEHOLDER_CLOSE = '￻'
const PLACEHOLDER_RE = /￹(\d+)￻/g

export interface ExtractedRawImages {
  /** Text with each renderer-handled `<img>` replaced by an inert placeholder. */
  text: string
  /** Replacement HTML, indexed by the placeholder number. */
  images: string[]
}

/**
 * Offer every raw `<img>` tag (plain or already-escaped) to the active
 * {@link RawImageRenderer}, swapping each accepted tag for an inert placeholder
 * so the surrounding prose can be inline-rendered and escaped without touching
 * the renderer's (already-safe) output. Restore with {@link restoreRawImages}
 * after escaping. With no renderer injected this is a no-op and the tags fall
 * through to the renderer's normal raw-HTML escaping.
 */
export function extractRawImages(text: string): ExtractedRawImages {
  const renderer = activeRawImageRenderer
  if (!renderer) return { text, images: [] }
  const images: string[] = []
  const out = text.replace(RAW_IMAGE_RE, (tag) => {
    const replacement = renderer({ tag, attrs: parseHtmlAttributes(tag) })
    if (replacement == null) return tag
    const index = images.push(replacement) - 1
    return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`
  })
  return { text: out, images }
}

/** Substitute the placeholders from {@link extractRawImages} back to their HTML. */
export function restoreRawImages(text: string, images: readonly string[]): string {
  if (images.length === 0) return text
  return text.replace(PLACEHOLDER_RE, (_match, index: string) => images[Number(index)] ?? '')
}
