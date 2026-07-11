// GFM extended email autolinks (#115): bare `user@host` addresses linkified as
// `mailto:` in ordinary prose. This is a GFM autolink-extension feature — base
// CommonMark and base GFM leave a bare address as plain text — so a consumer
// that targets base behaviour (or simply does not want addresses turned into
// links) can turn it off. The `www.`/URL forms are left on; disabling only the
// email pass matches the pre-extension behaviour where bare URLs still linked.
//
// On by default (GFM superset). Kept as a dependency-free leaf so the inline
// pipeline can read the flag without an import cycle, mirroring math-syntax.ts.
import { bumpConfigEpoch } from './config-epoch.ts'

let emailAutolinksEnabled = true

/**
 * Enable (default) or disable bare `user@host` → `mailto:` autolinking. Best set
 * once before the first render; a mid-stream flip bumps the config epoch, so the
 * stateful streaming renderer re-renders its committed prefix under the new
 * setting on the next update (#145) rather than leaving it stale.
 */
export function setEmailAutolinks(enabled: boolean): void {
  emailAutolinksEnabled = enabled
  bumpConfigEpoch()
}

/** Whether bare email addresses are linkified as `mailto:` (see module note). */
export function isEmailAutolinksEnabled(): boolean {
  return emailAutolinksEnabled
}
