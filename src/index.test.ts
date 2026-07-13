import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as api from './index.ts'
import * as hostWorkspace from './host-workspace.ts'

// The package entry (index.ts) is a pure re-export barrel — it is the published
// surface every consumer imports. This smoke test evaluates the barrel (so a
// broken re-export fails CI instead of a downstream install) and pins the set of
// exported runtime symbols so an accidental add/remove is caught in review.

const EXPECTED_FUNCTIONS = [
  'renderMarkdown',
  'renderMarkdownUnsafe',
  'renderStreamingMarkdown',
  'setDefaultConfig',
  'sanitizeRenderedMarkdown',
  'setSanitizedHtml',
  'isBrowserSanitizerSupported',
  'normalizeHostImagePath',
  'escapeHtml',
  'decodeHtmlEntities',
  'browserEntityDecoder',
  'fenceCodeClass',
  'highlightFenceCode',
  'getFenceHandler',
  'mermaidSourceCandidates',
  'prepareMermaidSource',
  'hydratePendingDiagrams',
  'hydratePendingMath',
  'renderAnchor',
] as const

describe('public API barrel (index.ts)', () => {
  it('re-exports every documented runtime symbol as a function', () => {
    for (const name of EXPECTED_FUNCTIONS) {
      assert.equal(
        typeof (api as Record<string, unknown>)[name],
        'function',
        `expected export "${name}" to be a function`,
      )
    }
  })

  it('re-exports the constructor and value constants', () => {
    assert.equal(typeof api.StreamingMarkdownRenderer, 'function')
    assert.equal(typeof api.PENDING_DIAGRAM_SELECTOR, 'string')
    assert.equal(typeof api.PENDING_MATH_SELECTOR, 'string')
    assert.ok(Array.isArray(api.DEFAULT_SAFE_HREF_SCHEMES))
    assert.ok(api.DEFAULT_SAFE_HREF_SCHEMES.includes('https'))
    assert.ok(api.KNOWN_LANGUAGES instanceof Set || Array.isArray(api.KNOWN_LANGUAGES))
  })

  it('the barrel adds no unexpected runtime exports', () => {
    const runtimeExports = Object.entries(api)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
      .sort()
    const expected = [
      ...EXPECTED_FUNCTIONS,
      'StreamingMarkdownRenderer',
      'FORMING_FENCE_PRE_CLASS',
      'PENDING_DIAGRAM_SELECTOR',
      'PENDING_MATH_SELECTOR',
      'DEFAULT_SAFE_HREF_SCHEMES',
      'KNOWN_LANGUAGES',
      'browserSanitizerBackend',
    ].sort()
    assert.deepEqual(runtimeExports, expected)
  })

  // The `@experimental` tier was removed from the main entry at 1.0 (#147):
  // ambient-config introspection getters, low-level renderer internals, and
  // the built-in entity table stay in their source modules for in-repo use
  // but must NOT leak back into the published barrel.
  it('keeps the removed experimental tier off the main barrel', () => {
    for (const name of [
      'getHtmlPolicy',
      'getSafeHrefSchemes',
      'getMathSyntax',
      'getLinkImagePolicy',
      'getEntityDecoder',
      'getNamedEntities',
      'getInlinePasses',
      'getCodeHighlighter',
      'isEmailAutolinksEnabled',
      'splitForStreaming',
      'escapeHtmlTextNodes',
      'decodeSafeMarkdownEntities',
      'BUILTIN_NAMED_ENTITIES',
    ]) {
      assert.equal(
        (api as Record<string, unknown>)[name],
        undefined,
        `expected experimental symbol "${name}" to be off the main entry`,
      )
    }
  })

  // Host-specific helpers moved off the main entry (#112): they must NOT leak
  // back into the barrel, and they must remain reachable via the dedicated
  // `@copse/streaming-markdown/host/workspace` subpath entry.
  it('keeps host/workspace helpers off the main barrel', () => {
    for (const name of [
      'appLinkDecorator',
      'stripAppImageAttributes',
      'stripAppLinkAttributes',
      'stripAppCodeDecorations',
      'isWorkspaceMarkdownLinkHref',
      'workspaceLinkTargetFromHref',
    ]) {
      assert.equal(
        (api as Record<string, unknown>)[name],
        undefined,
        `expected "${name}" to be off the main entry`,
      )
    }
  })

  it('exposes host/workspace helpers on the host subpath', () => {
    for (const name of [
      'appLinkDecorator',
      'stripAppImageAttributes',
      'stripAppLinkAttributes',
      'stripAppCodeDecorations',
      'isWorkspaceMarkdownLinkHref',
      'workspaceLinkTargetFromHref',
    ]) {
      assert.equal(
        typeof (hostWorkspace as Record<string, unknown>)[name],
        'function',
        `expected host/workspace export "${name}" to be a function`,
      )
    }
  })
})
