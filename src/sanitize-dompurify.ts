import DOMPurify from 'dompurify'
import type { SanitizerBackend, SanitizerConfig } from './sanitize.ts'

// DOMPurify sanitizer backend. This is the only module that imports `dompurify`,
// so hosts that use the native Sanitizer API (or their own backend) never pull it
// into their bundle. Register it in Node/jsdom or older browsers:
//
//   import { setSanitizerBackend } from '@copse/streaming-markdown'
//   import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'
//   setSanitizerBackend(dompurifyBackend)
//
// The backend deliberately uses a strict tag/attr allowlist (never a FORBID_TAGS
// denylist) and string output (never RETURN_DOM) — see the advisory-posture tests
// in sanitize.test.ts.

// A single global `uponSanitizeElement` hook forwards to the per-call
// `onElement` gate. Sanitization is synchronous and single-threaded, so setting
// the active gate around the `DOMPurify.sanitize` call is safe.
let hookInstalled = false
let activeOnElement: SanitizerConfig['onElement']

function installHook(): void {
  if (hookInstalled) return
  hookInstalled = true
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    activeOnElement?.(node as Element, data.tagName)
  })
}

export const dompurifyBackend: SanitizerBackend = {
  sanitize(html: string, config: SanitizerConfig): string {
    installHook()
    activeOnElement = config.onElement
    try {
      return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: [...config.allowedTags],
        ALLOWED_ATTR: [...config.allowedAttr],
      })
    } finally {
      activeOnElement = undefined
    }
  },
}
