import { FORMING_FENCE_PRE_CLASS } from './fence-handlers.ts'
import { mathBlockHtml, parseOpenMathBlock, syncFormingMathBlockDom } from './math-block.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

// Forming display-math blocks (#70): the streaming analogue of
// streaming-fence-dom.ts for `$$ … $$` / `\[ … \]` blocks. While the block is
// open, both emitters show the body streamed so far inside the pending math
// scaffolding — a half-open `$$` never flashes raw. ```math fences reach the
// same markup through the built-in fence handler instead.

/** Build forming-math HTML for the string streaming API. */
export function buildFormingMathHtml(source: string): string {
  return sanitizeRenderedMarkdown(mathBlockHtml(parseOpenMathBlock(source), FORMING_FENCE_PRE_CLASS))
}

/** Forward-pass DOM updates for a display-math block still streaming. */
export function syncFormingMathDom(container: HTMLElement, source: string): void {
  syncFormingMathBlockDom(container, parseOpenMathBlock(source), FORMING_FENCE_PRE_CLASS)
}
