// GFM extended email autolinks (#115): bare `user@host` addresses linkified as
// `mailto:` in ordinary prose. This is a GFM autolink-extension feature — base
// CommonMark and base GFM leave a bare address as plain text — so a consumer
// that targets base behaviour (or simply does not want addresses turned into
// links) can turn it off. The `www.`/URL forms are left on; disabling only the
// email pass matches the pre-extension behaviour where bare URLs still linked.
//
// On by default (GFM superset). Kept as a dependency-free leaf so the inline
// pipeline can read the flag without an import cycle, mirroring math-syntax.ts.

let emailAutolinksEnabled = true

/**
 * Enable (default) or disable bare `user@host` → `mailto:` autolinking. Set it
 * once before the first render — the flag is read by the shared inline
 * pipeline, so a mid-stream flip only affects regions (re)rendered afterwards;
 * re-render at rest (or recreate the streaming renderer) for a clean switch.
 */
export function setEmailAutolinks(enabled: boolean): void {
  emailAutolinksEnabled = enabled
}

/** Whether bare email addresses are linkified as `mailto:` (see module note). */
export function isEmailAutolinksEnabled(): boolean {
  return emailAutolinksEnabled
}
