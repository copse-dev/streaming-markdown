// A generic host image policy for tests. Image handling is host-injected: the
// core renderer escapes raw `<img>` and allows none through the sanitizer. This
// fixture simulates a host (the real policy lives in the consuming app) so the
// injection surface — `setRawImageRenderer` + `setSanitizeExtension` — can be
// exercised. An `<img>` whose `src` resolves (via `normalizeHostImagePath`) to a
// stable `artifacts/…` path becomes a locked-down, src-less placeholder; every
// other tag falls through to escaping.
//
// The renderer normalizes the path so volatile prefixes — a container abs path
// (`/opt/cursor/artifacts/…`), a repo/dir name (`/home/user/<repo>/artifacts/…`),
// or a per-session download URL — all collapse to the same
// `data-host-image-path`. That determinism is what stops the rendered DOM (and
// any screenshot of it) from churning when those environment details change.
import { setDefaultConfig } from '../src/config.ts'
import { normalizeHostImagePath, type RawImageTag } from '../src/raw-images.ts'
import { escapeHtml } from '../src/escape.ts'

const HOST_IMAGE_CLASS = 'host-image'

function hostImageRenderer({ attrs }: RawImageTag): string | null {
  const src = attrs['src']
  if (!src) return null
  const normalized = normalizeHostImagePath(src)
  if (!normalized) return null
  const alt = escapeHtml(attrs['alt'] ?? '')
  // Only the stable relative path reaches the rendered attribute; the volatile
  // query params (e.g. a session id) stay out of anything a screenshot captures.
  return `<img class="${HOST_IMAGE_CLASS}" data-host-image-path="${escapeHtml(normalized.path)}" alt="${alt}" loading="lazy">`
}

const hostImageSanitize = {
  allowedTags: ['img'],
  allowedAttr: ['data-host-image-path', 'alt', 'loading'],
  onElement(node: Element, tagName: string): void {
    if (tagName !== 'img') return
    // Class-gate: drop any image that is not this host's placeholder.
    if (node.getAttribute('class') !== HOST_IMAGE_CLASS) {
      node.remove()
      return
    }
    // Placeholders carry no `src` until the host hydrates them post-sanitize.
    node.removeAttribute('src')
  },
}

export function installHostImagePolicy(): void {
  setDefaultConfig({ rawImageRenderer: hostImageRenderer, sanitizeExtension: hostImageSanitize })
}

export function resetHostImagePolicy(): void {
  setDefaultConfig({ rawImageRenderer: null, sanitizeExtension: null })
}

/** Run `body` with the host image policy installed, resetting afterward. */
export function withHostImagePolicy(body: () => void): void {
  installHostImagePolicy()
  try {
    body()
  } finally {
    resetHostImagePolicy()
  }
}
