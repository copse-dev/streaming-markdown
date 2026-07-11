import { bumpConfigEpoch } from './config-epoch.ts'
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
  bumpConfigEpoch()
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

/** A host image `src` reduced to a stable, machine-independent form. */
export interface NormalizedImagePath {
  /**
   * The image path relative to (and including) the root marker segment, e.g.
   * `artifacts/screenshots/x.png`. Deterministic across machines: any leading
   * absolute/container/repo directory prefix is stripped.
   */
  path: string
  /**
   * Query params carried by a URL `src` (e.g. a per-session agent id). These are
   * volatile and MUST be kept out of any attribute that ends up in a rendered
   * snapshot/screenshot — surface them separately (or use them only at fetch
   * time) so they can't churn the committed image. Omitted when the `src` was a
   * plain path with no query string.
   */
  params?: Record<string, string>
}

export interface NormalizeImagePathOptions {
  /**
   * The path segment that anchors the stable relative path. Everything before the
   * first occurrence of this segment is discarded; the segment and everything
   * after it are kept. Defaults to `'artifacts'`.
   */
  rootMarker?: string
}

/**
 * Reduce a raw image `src` to a stable, machine-independent {@link NormalizedImagePath},
 * or `null` when it does not contain the root marker (host should then fall through
 * to escaping). This is the determinism primitive behind screenshot churn: agent
 * output references the same artifact through volatile forms —
 *
 *   - `artifacts/screenshots/x.png`                              (already relative)
 *   - `/opt/cursor/artifacts/screenshots/x.png`                 (container abs path)
 *   - `/home/user/some-repo/artifacts/screenshots/x.png`        (repo/dir names leak)
 *   - `https://host/v1/agents/<session>/artifacts/download?path=artifacts/screenshots/x.png`
 *
 * — all of which must render identically. This collapses each to the same
 * `artifacts/screenshots/x.png` so the rendered DOM (and any screenshot of it) stops
 * changing when the container dir, repo name, directory layout, or session id changes.
 *
 * The core stays app-agnostic: no host path is hardcoded — the anchor segment is the
 * caller-supplied {@link NormalizeImagePathOptions.rootMarker}. Path traversal
 * (`..`) is rejected as a safety measure.
 */
export function normalizeHostImagePath(
  rawSrc: string,
  options: NormalizeImagePathOptions = {},
): NormalizedImagePath | null {
  const rootMarker = options.rootMarker ?? 'artifacts'
  const src = rawSrc.trim()
  if (!src) return null

  let candidate = src
  let params: Record<string, string> | undefined

  // A URL src carries the stable path in its `?path=` query param (the URL's own
  // pathname holds a volatile per-session id); prefer it. Other query params are
  // returned separately so the host keeps them out of snapshot-visible attributes.
  const url = tryParseUrl(src)
  if (url) {
    const pathParam = url.searchParams.get('path')
    candidate = pathParam ?? url.pathname
    const rest: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
      if (key === 'path') continue
      rest[key] = value
    }
    if (Object.keys(rest).length > 0) params = rest
  }

  const path = stableRelativePath(candidate, rootMarker)
  if (path == null) return null
  return params ? { path, params } : { path }
}

function tryParseUrl(src: string): URL | null {
  // Only absolute URLs (with a scheme) are URLs here; bare paths must not be
  // coerced (no base is supplied), so `new URL(src)` naturally rejects them.
  try {
    return new URL(src)
  } catch {
    return null
  }
}

/**
 * Keep the `rootMarker` segment and everything after it, discarding any leading
 * directory prefix. Returns `null` if the marker is absent or a `..` segment would
 * escape the root.
 */
function stableRelativePath(rawPath: string, rootMarker: string): string | null {
  const segments = rawPath.split('/').filter((segment) => segment !== '' && segment !== '.')
  const start = segments.indexOf(rootMarker)
  if (start === -1) return null
  const kept = segments.slice(start)
  if (kept.includes('..')) return null
  return kept.join('/')
}
