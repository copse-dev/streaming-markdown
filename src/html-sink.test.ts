// Tests for the innerHTML chokepoint (html-sink.ts): sanitize-then-bless
// behavior, Trusted Types policy resolution (default policy, host policy, CSP
// rejection fallback), and the source-scan guard that keeps every production
// `innerHTML` write inside the chokepoint.
import '../tests/setup-dom-jsdom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  setHostTrustedHtml,
  setPresanitizedHtml,
  setSanitizedHtml,
  setTrustedTypesPolicy,
  type TrustedTypesPolicy,
} from './html-sink.ts'
import { sanitizeRenderedMarkdown, setSanitizerBackend } from './sanitize.ts'
import { dompurifyBackend } from './sanitize-dompurify.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

// The jsdom setup registers the DOMPurify backend, whose `sanitizeInto` node
// path bypasses `innerHTML` (and therefore the Trusted Types policy) entirely.
// Tests that exercise the policy string path pin a string-only backend — the
// same shape as a custom host backend without a node path.
function forceStringSanitizePath(): void {
  setSanitizerBackend({ sanitize: (html, config) => dompurifyBackend.sanitize(html, config) })
}

interface StubPolicy extends TrustedTypesPolicy {
  name: string
  /** Inputs passed to createHTML, in order. */
  calls: string[]
}

// Minimal trustedTypes shim: policies mint objects whose toString() returns the
// rule output, which jsdom's WebIDL DOMString coercion stringifies on innerHTML
// assignment — the same observable flow as a real Trusted Types browser.
function makeStubPolicy(name: string, rule: (input: string) => string): StubPolicy {
  const policy: StubPolicy = {
    name,
    calls: [],
    createHTML(input: string) {
      policy.calls.push(input)
      return { toString: () => rule(input) }
    },
  }
  return policy
}

function installStubTrustedTypes(): { created: StubPolicy[] } {
  const created: StubPolicy[] = []
  ;(globalThis as Record<string, unknown>)['trustedTypes'] = {
    createPolicy(name: string, rules: { createHTML: (input: string) => string }) {
      const policy = makeStubPolicy(name, rules.createHTML)
      created.push(policy)
      return policy
    },
  }
  return { created }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['trustedTypes']
  // Also re-arms the default-policy probe for the next test.
  setTrustedTypesPolicy(null)
  // Restore the backend the jsdom setup registered.
  setSanitizerBackend(dompurifyBackend)
})

describe('setSanitizedHtml', () => {
  it('sanitizes before assignment', () => {
    const el = document.createElement('div')
    setSanitizedHtml(el, '<p onclick="x()">hi</p><script>alert(1)</script><img src=x onerror=y>')
    assert.equal(el.innerHTML, '<p>hi</p>')
  })

  it('clears the element for empty input without touching a policy', () => {
    installStubTrustedTypes()
    const el = document.createElement('div')
    el.innerHTML = '<p>old</p>'
    setSanitizedHtml(el, '')
    assert.equal(el.innerHTML, '')
  })

  it('lazily creates the default streaming-markdown policy and routes writes through it', () => {
    forceStringSanitizePath()
    const { created } = installStubTrustedTypes()
    setTrustedTypesPolicy(null) // re-probe now that the shim exists
    const el = document.createElement('div')
    setSanitizedHtml(el, '<p>one</p>')
    setSanitizedHtml(el, '<p>two</p>')
    assert.equal(created.length, 1, 'policy is created once and reused')
    const policy = created[0]
    assert.ok(policy)
    assert.equal(policy.name, 'streaming-markdown')
    assert.deepEqual(policy.calls, ['<p>one</p>', '<p>two</p>'])
    assert.equal(el.innerHTML, '<p>two</p>')
  })

  it('prefers a host-injected policy and hands it pre-sanitized markup', () => {
    forceStringSanitizePath()
    const { created } = installStubTrustedTypes()
    const hostPolicy = makeStubPolicy('my-app#markdown', (s) => s)
    setTrustedTypesPolicy(hostPolicy)
    const el = document.createElement('div')
    setSanitizedHtml(el, '<p>keep</p><script>bad()</script>')
    assert.equal(created.length, 0, 'default policy is never created')
    assert.deepEqual(hostPolicy.calls, ['<p>keep</p>'], 'policy input is already sanitized')
    assert.equal(el.innerHTML, '<p>keep</p>')
  })

  it('works with a host policy even when no trustedTypes global exists', () => {
    forceStringSanitizePath()
    const hostPolicy = makeStubPolicy('my-app#markdown', (s) => s)
    setTrustedTypesPolicy(hostPolicy)
    const el = document.createElement('div')
    setSanitizedHtml(el, '**not markdown-rendered** <em>em</em>')
    assert.equal(hostPolicy.calls.length, 1)
    assert.equal(el.innerHTML, '**not markdown-rendered** <em>em</em>')
  })

  it('reuses the created default policy after a host set/unset cycle', () => {
    forceStringSanitizePath()
    // Strict-CSP factory: re-creating a policy name throws (no 'allow-duplicates').
    const created: StubPolicy[] = []
    ;(globalThis as Record<string, unknown>)['trustedTypes'] = {
      createPolicy(name: string, rules: { createHTML: (input: string) => string }) {
        if (created.some((p) => p.name === name)) {
          throw new TypeError(`Policy "${name}" already exists`)
        }
        const policy = makeStubPolicy(name, rules.createHTML)
        created.push(policy)
        return policy
      },
    }
    setTrustedTypesPolicy(null)
    const el = document.createElement('div')
    setSanitizedHtml(el, '<p>one</p>') // lazily creates the default policy
    setTrustedTypesPolicy(makeStubPolicy('my-app#markdown', (s) => s))
    setSanitizedHtml(el, '<p>two</p>') // host policy takes over
    setTrustedTypesPolicy(null) // restore the default — must reuse, not re-create
    setSanitizedHtml(el, '<p>three</p>')
    assert.equal(created.length, 1, 'default policy created exactly once')
    assert.deepEqual(created[0]?.calls, ['<p>one</p>', '<p>three</p>'])
    assert.equal(el.innerHTML, '<p>three</p>')
  })

  it('falls back to plain strings when createPolicy is rejected by CSP', () => {
    forceStringSanitizePath()
    ;(globalThis as Record<string, unknown>)['trustedTypes'] = {
      createPolicy(): never {
        throw new TypeError('Policy "streaming-markdown" disallowed')
      },
    }
    setTrustedTypesPolicy(null)
    const el = document.createElement('div')
    setSanitizedHtml(el, '<p>still works</p>')
    assert.equal(el.innerHTML, '<p>still works</p>')
  })
})

describe('setSanitizedHtml node path (backend sanitizeInto)', () => {
  it('bypasses innerHTML and the Trusted Types policy entirely', () => {
    const hostPolicy = makeStubPolicy('my-app#markdown', (s) => s)
    setTrustedTypesPolicy(hostPolicy)
    const el = document.createElement('div')
    setSanitizedHtml(el, '<p>keep</p><script>bad()</script>')
    assert.equal(hostPolicy.calls.length, 0, 'no policy needed on the node path')
    assert.equal(el.innerHTML, '<p>keep</p>')
  })

  it('serializes identically to the string path', () => {
    const dirty =
      '<h2 id="x">Title</h2>\n<ul><li class="task-list-item">' +
      '<input type="checkbox" checked> done</li></ul>' +
      '<input type="text" name="evil"><td>stray</td>tail &amp; text'
    const el = document.createElement('div')
    setSanitizedHtml(el, dirty)
    assert.equal(el.innerHTML, sanitizeRenderedMarkdown(dirty))
  })

  it('applies the double-encoded nbsp normalization like the string path', () => {
    const el = document.createElement('div')
    setSanitizedHtml(el, '<p>a&amp;nbsp;b</p>')
    const fresh = document.createElement('div')
    fresh.innerHTML = sanitizeRenderedMarkdown('<p>a&amp;nbsp;b</p>')
    assert.equal(el.innerHTML, fresh.innerHTML)
    assert.equal(el.querySelector('p')?.textContent, 'a b')
  })

  it('normalizes the hex NBSP escape but not the hex LF escape', () => {
    const dirty = '<p>a&amp;#xA0;b c&amp;#xA;d</p>'
    const el = document.createElement('div')
    setSanitizedHtml(el, dirty)
    const fresh = document.createElement('div')
    fresh.innerHTML = sanitizeRenderedMarkdown(dirty)
    assert.equal(el.innerHTML, fresh.innerHTML, 'node and string paths agree')
    assert.equal(el.querySelector('p')?.textContent, 'a b c&#xA;d')
  })

  it('replaces existing children', () => {
    const el = document.createElement('div')
    el.innerHTML = '<p>old</p><p>content</p>'
    setSanitizedHtml(el, '<em>new</em>')
    assert.equal(el.innerHTML, '<em>new</em>')
  })
})

describe('setPresanitizedHtml', () => {
  it('assigns without re-sanitizing but still blesses through the active policy', () => {
    const hostPolicy = makeStubPolicy('my-app#markdown', (s) => s)
    setTrustedTypesPolicy(hostPolicy)
    const el = document.createElement('div')
    setPresanitizedHtml(el, '<p>already sanitized</p>')
    assert.deepEqual(hostPolicy.calls, ['<p>already sanitized</p>'])
    assert.equal(el.innerHTML, '<p>already sanitized</p>')
  })

  it('clears the element for empty input', () => {
    const el = document.createElement('div')
    el.innerHTML = '<p>old</p>'
    setPresanitizedHtml(el, '')
    assert.equal(el.innerHTML, '')
  })
})

describe('setHostTrustedHtml', () => {
  it('clears the element for empty input without touching a TT sink', () => {
    const el = document.createElement('div')
    el.innerHTML = '<svg></svg>'
    setHostTrustedHtml(el, '')
    assert.equal(el.innerHTML, '')
  })

  it('assigns a TrustedHTML-like value without touching the markdown policy', () => {
    const hostPolicy = makeStubPolicy('my-app#markdown', (s) => s)
    setTrustedTypesPolicy(hostPolicy)
    const el = document.createElement('div')
    setHostTrustedHtml(el, { toString: () => '<svg><title>diagram</title></svg>' })
    assert.equal(hostPolicy.calls.length, 0, 'markdown policy never blesses host markup')
    assert.equal(el.innerHTML, '<svg><title>diagram</title></svg>')
  })
})

describe('streaming DOM emitter under Trusted Types', () => {
  it('renders through the default policy end-to-end', () => {
    const { created } = installStubTrustedTypes()
    setTrustedTypesPolicy(null)
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('# Title\n\nsome **bold**')
    r.update('# Title\n\nsome **bold** text\n\n- item one\n- item')
    assert.match(host.querySelector('.stream-complete')?.innerHTML ?? '', /<h1>Title<\/h1>/)
    assert.match(host.innerHTML, /<strong>bold<\/strong>/)
    assert.equal(created.length, 1)
    const policy = created[0]
    assert.ok(policy)
    assert.ok(policy.calls.length > 0, 'DOM writes routed through the policy')
  })
})

describe('innerHTML chokepoint guard', () => {
  it('no production source writes an HTML injection sink outside html-sink.ts', () => {
    const srcDir = dirname(fileURLToPath(import.meta.url))
    const offenders: string[] = []
    // Assignment sinks only — reads like `const s = el.innerHTML` stay legal.
    const sinkRe =
      /\.(?:innerHTML|outerHTML)\s*=[^=]|\.insertAdjacentHTML\s*\(|document\.write/
    for (const file of readdirSync(srcDir, { recursive: true }) as string[]) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'html-sink.ts') continue
      const lines = readFileSync(join(srcDir, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        // Prose references in comments (e.g. "identical to `innerHTML = html`")
        // are fine; only code can reach a sink.
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        if (sinkRe.test(line)) offenders.push(`${file}:${i + 1}: ${trimmed}`)
      })
    }
    assert.deepEqual(
      offenders,
      [],
      'HTML injection sinks must go through html-sink.ts (setSanitizedHtml / setPresanitizedHtml / setHostTrustedHtml)',
    )
  })
})
