import { splitForStreaming, type StreamingSplit } from '../src/streaming-split.ts'

/**
 * `splitForStreaming` result without the (deterministic) `blocks` token array,
 * so commit-boundary contract assertions can `deepEqual` against just the split
 * fields (#21). Shared by the tokenizer and streaming test suites.
 */
export function splitCore(content: string): StreamingSplit {
  const { blocks: _blocks, ...core } = splitForStreaming(content)
  return core
}
