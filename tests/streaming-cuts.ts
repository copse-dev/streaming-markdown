/**
 * Cut indices exercised when fuzzing an input through the streaming renderer.
 * Short inputs try every prefix length; longer ones still hit every newline and
 * a strided sample so runtime stays bounded. Shared by the convergence and
 * display-invariant property suites.
 */
export function streamingCutIndices(text: string): number[] {
  const len = text.length
  if (len <= 256 || process.env['STREAMING_FUZZ_ALL'] === '1') {
    return Array.from({ length: len + 1 }, (_, i) => i)
  }
  const cuts = new Set<number>([0, len])
  for (let i = 0; i < len; i++) {
    if (text[i] === '\n' || i < 32 || i >= len - 32) cuts.add(i)
  }
  const stride = Math.max(1, Math.ceil(len / 128))
  for (let i = 0; i <= len; i += stride) cuts.add(i)
  return [...cuts].sort((a, b) => a - b)
}
