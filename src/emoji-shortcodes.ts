import type { InlinePass, InlinePassContext } from './inline-passes.ts'
import { emojiShortcodes } from './emoji-shortcode-map.ts'

// The optional emoji-shortcode inline pass (#86): maps `:smile:` → 😄 for hosts
// whose LLM emits GitHub-style shortcodes. It is the inline-pass analogue of the
// highlight/mermaid backends — a ready-made plugin built entirely on the public
// `MarkdownConfig.inlinePasses` contract (`inline-passes.ts`), shipped behind its
// own `@copse/streaming-markdown/inline/emoji` subpath so the (large) gemoji table
// lands in a bundle only when a host references this entry. Nothing here is in
// the default bundle; a consumer that never imports it pays zero bytes.
//
//   import { renderMarkdown } from '@copse/streaming-markdown'
//   import { emojiInlinePass } from '@copse/streaming-markdown/inline/emoji'
//   renderMarkdown(md, { inlinePasses: [emojiInlinePass] })
//   // or once at setup: setDefaultConfig({ inlinePasses: [emojiInlinePass] })
//
// The registry already carries the three inline-extension costs for us
// (`inline-passes.ts`): the pass only sees text *outside* rendered
// `<code>`/`<a>`/`<img>` spans, backslash escapes are inert before it runs
// (`\:smile:` stays literal), and `holdStart` suppresses a half-typed `:smi`
// mid-stream. Unknown shortcodes are returned untouched.

/** The shipped GitHub/gemoji shortcode table (re-exported for inspection/extension). */
export { emojiShortcodes } from './emoji-shortcode-map.ts'

/**
 * A complete `:shortcode:` occurrence. The class `[a-z0-9_+-]` is exactly the
 * gemoji alias alphabet (`+1`, `e-mail`, `100`, `1st_place_medal`, …), so every
 * shipped name is reachable and nothing outside a gemoji alias can match.
 */
const SHORTCODE_RE = /:([a-z0-9_+-]+):/g

/** One character of a `:shortcode:` body (the {@link SHORTCODE_RE} class). */
const SHORTCODE_CHAR_RE = /^[a-z0-9_+-]$/

/**
 * Build an emoji inline pass over a custom shortcode table. Pass your own map to
 * extend or replace the shipped gemoji names (e.g. add team-specific codes);
 * omit it for the built-in {@link emojiShortcodes}. Keys are matched literally
 * against `[a-z0-9_+-]+` shortcode bodies; values are emitted as trusted HTML
 * (plain-Unicode emoji need no sanitizer widening — a custom `<img>` glyph
 * would, like any pass-emitted markup).
 */
export function createEmojiInlinePass(
  shortcodes: Readonly<Record<string, string>> = emojiShortcodes,
): InlinePass {
  // A Map both gives O(1) lookup and closes a prototype-pollution hole: a plain
  // object would resolve `:constructor:` / `:tostring:` to inherited members and
  // emit them as text; `Map.get` only ever sees own entries.
  const table = new Map(Object.entries(shortcodes))
  return {
    name: 'emoji',
    apply(text: string, ctx: InlinePassContext): string {
      if (!text.includes(':')) return text
      return text.replace(SHORTCODE_RE, (match, name: string) => {
        const glyph = table.get(name)
        // Unknown shortcodes pass through literally; the emitted glyph is shielded
        // from later passes and the escape step like any pass output.
        return glyph === undefined ? match : ctx.emit(glyph)
      })
    },
    holdStart(line: string, mask: boolean[]): number {
      // Suppress a half-open `:smi` in the pending tail so no partial shortcode
      // flashes before its closing colon arrives — the citation/strikethrough
      // hold, adapted to colon-delimited runs. Colons toggle open/close as we
      // scan; a non-shortcode character between them proves the leading colon was
      // ordinary prose, not an opener.
      let openAt = -1
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === ':' && !mask[i]) {
          openAt = openAt === -1 ? i : -1
        } else if (openAt !== -1 && !SHORTCODE_CHAR_RE.test(ch ?? '')) {
          openAt = -1
        }
      }
      // `openAt !== -1` now means a trailing colon followed only by shortcode
      // characters to end-of-line. Hold only when at least one such character
      // follows: a bare trailing colon ("Steps:", "Note:") is prose, not a
      // half-typed shortcode, and must never be truncated mid-stream.
      if (openAt !== -1 && SHORTCODE_CHAR_RE.test(line[openAt + 1] ?? '')) return openAt
      return line.length
    },
  }
}

/** The ready-made emoji pass over the shipped {@link emojiShortcodes} table. */
export const emojiInlinePass: InlinePass = createEmojiInlinePass()
