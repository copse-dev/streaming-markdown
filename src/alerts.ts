/**
 * GitHub alerts (#72): blockquotes whose first line is exactly `[!NOTE]` (or
 * TIP / IMPORTANT / WARNING / CAUTION, case-insensitive) render with GitHub's
 * `markdown-alert markdown-alert-<type>` classes and a leading
 * `<p class="markdown-alert-title">` instead of quoted prose. Unknown
 * `[!FOO]` markers fall through to a plain blockquote with the marker line
 * rendered literally (GitHub behavior).
 *
 * This module is a leaf on purpose (block-patterns only): the block renderer
 * classifies committed quotes and the streaming pending path classifies the
 * marker line the moment it is complete, so a `> [!NOTE]` never flashes as a
 * literal `[!NOTE]` paragraph before upgrading.
 */
import { stripBlockquoteMarker } from './block-patterns.ts'

/** The five GitHub alert types, keyed by their marker word (lowercased). */
const ALERT_TITLES = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
} as const

export type AlertType = keyof typeof ALERT_TITLES

/** A complete alert marker — `[!TYPE]` and nothing else (case-insensitive). */
const ALERT_MARKER_RE = /^\[!([A-Za-z]+)\]$/

/**
 * Alert type of a blockquote content line, or null. The marker must be the
 * ENTIRE line (`> [!NOTE] extra` is not an alert — GitHub behavior) and name a
 * known type; `[!FOO]` returns null so the caller falls through to a plain
 * blockquote.
 */
export function alertTypeFromMarker(bodyLine: string): AlertType | null {
  const word = ALERT_MARKER_RE.exec(bodyLine.trim())?.[1]?.toLowerCase()
  if (word !== undefined && word in ALERT_TITLES) return word as AlertType
  return null
}

/** Display title for an alert type (`note` → `Note`). */
export function alertTitle(type: AlertType): string {
  return ALERT_TITLES[type]
}

/** GitHub-compatible class list for an alert blockquote. */
export function alertBlockquoteClass(type: AlertType): string {
  return `markdown-alert markdown-alert-${type}`
}

/**
 * Streaming: a blockquote body that is a still-forming alert marker (`[!`,
 * `[!NOT` — opened, no `]` yet). Such a tail is held (rendered as nothing)
 * so a partial marker never flashes literally; once the `]` arrives it either
 * classifies (known type) or renders literally (unknown, GitHub fallthrough).
 */
export function isFormingAlertMarker(body: string): boolean {
  // A bare `[` may still grow the `!`; once another character follows it is a
  // forming LINK label instead and the link-reveal path owns it.
  return /^\[$|^\[![A-Za-z]*$/.test(body.trim())
}

/**
 * Alert type of a streaming pending blockquote LINE (`> [!NOTE]` with the
 * marker complete), or null. Shared by both emitters so the pending element's
 * class/title and the committed render classify identically.
 */
export function pendingBlockquoteAlertType(pendingLine: string): AlertType | null {
  return alertTypeFromMarker(stripBlockquoteMarker(pendingLine))
}
