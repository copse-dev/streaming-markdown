// A generic host image policy for tests. Image handling is host-injected: the
// core renderer escapes raw `<img>` and allows none through the sanitizer. This
// fixture simulates a host (the real policy lives in the consuming app) so the
// injection surface — `setRawImageRenderer` + `setSanitizeExtension` — can be
// exercised. Only an `<img>` whose `src` starts with `artifacts/` becomes a
// locked-down, src-less placeholder; everything else falls through to escaping.
import { setRawImageRenderer, type RawImageTag } from '../src/raw-images.ts'
import { setSanitizeExtension } from '../src/sanitize.ts'
import { escapeHtml } from '../src/escape.ts'

const HOST_IMAGE_CLASS = 'host-image'

function hostImageRenderer({ attrs }: RawImageTag): string | null {
  const src = attrs['src']
  if (!src || !src.startsWith('artifacts/')) return null
  const alt = escapeHtml(attrs['alt'] ?? '')
  return `<img class="${HOST_IMAGE_CLASS}" data-host-image-path="${escapeHtml(src)}" alt="${alt}" loading="lazy">`
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
  setRawImageRenderer(hostImageRenderer)
  setSanitizeExtension(hostImageSanitize)
}

export function resetHostImagePolicy(): void {
  setRawImageRenderer(null)
  setSanitizeExtension(null)
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
