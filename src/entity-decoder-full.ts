/**
 * Full HTML5 character-reference decoding, backed by the `entities` package.
 *
 * Importing this module pulls the full ~2,100-entry named table into the bundle
 * (~23 KB gzip) — the cost the default decoder avoids. Use it when you need
 * strict CommonMark conformance for the long tail of named references and are
 * not in a DOM (where `browserEntityDecoder` gives the same coverage for free).
 *
 * `entities` is an optional peer dependency; install it alongside this import.
 */
import { decodeHTMLStrict } from 'entities'
import type { EntityDecoder } from './entity-decoder.ts'

/**
 * The full HTML5 strict decoder (numeric + all named references, `;` required).
 * Pass it via `MarkdownConfig.entityDecoder` to use the full table for a render.
 */
export const fullEntityDecoder: EntityDecoder = decodeHTMLStrict
