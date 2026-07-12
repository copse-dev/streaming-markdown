import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHostImagePath } from './raw-images.ts'
import { withHostImagePolicy } from '../tests/host-image-test-policy.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

describe('normalizeHostImagePath — screenshot determinism (#churn)', () => {
  it('leaves an already-relative artifacts path unchanged', () => {
    assert.deepEqual(normalizeHostImagePath('artifacts/screenshots/x.png'), {
      path: 'artifacts/screenshots/x.png',
    })
  })

  it('strips a container absolute prefix down to the root marker', () => {
    assert.deepEqual(normalizeHostImagePath('/opt/runner/artifacts/screenshots/x.png'), {
      path: 'artifacts/screenshots/x.png',
    })
  })

  it('strips a repo/directory-named prefix so repo names never leak', () => {
    assert.deepEqual(normalizeHostImagePath('/home/user/some-repo/artifacts/screenshots/x.png'), {
      path: 'artifacts/screenshots/x.png',
    })
  })

  it('collapses every volatile form of the same artifact to one identical path', () => {
    const forms = [
      'artifacts/screenshots/x.png',
      '/opt/runner/artifacts/screenshots/x.png',
      '/home/user/some-repo/artifacts/screenshots/x.png',
      '/tmp/build-9f3a/checkout/artifacts/screenshots/x.png',
      'https://host.example/v1/agents/session-abc123/artifacts/download?path=artifacts/screenshots/x.png',
    ]
    const paths = new Set(forms.map((src) => normalizeHostImagePath(src)?.path))
    assert.deepEqual([...paths], ['artifacts/screenshots/x.png'])
  })

  it('keeps a URL session id out of the stable path (in params, not the rendered attribute)', () => {
    const normalized = normalizeHostImagePath(
      'https://host.example/v1/agents/session-abc123/artifacts/download?path=artifacts/screenshots/x.png&token=xyz',
    )
    assert.equal(normalized?.path, 'artifacts/screenshots/x.png')
    // Volatile bits are surfaced separately, never folded into `path`.
    assert.deepEqual(normalized?.params, { token: 'xyz' })
    assert.doesNotMatch(normalized?.path ?? '', /session-abc123/)
  })

  it('accepts a caller-supplied root marker (no host path is hardcoded in core)', () => {
    assert.deepEqual(normalizeHostImagePath('/srv/data/uploads/a/b.png', { rootMarker: 'uploads' }), {
      path: 'uploads/a/b.png',
    })
  })

  it('returns null when the marker is absent (host falls through to escaping)', () => {
    assert.equal(normalizeHostImagePath('/etc/passwd'), null)
    assert.equal(normalizeHostImagePath('https://host.example/logo.png'), null)
    assert.equal(normalizeHostImagePath(''), null)
  })

  it('rejects path traversal that would escape the root', () => {
    assert.equal(normalizeHostImagePath('artifacts/../../etc/passwd'), null)
  })
})

describe('host image policy renders volatile srcs to one stable placeholder', () => {
  it('renders the container-absolute and relative forms identically', () => {
    withHostImagePolicy(() => {
      const abs = renderMarkdownUnsafe('<img alt="shot" src="/opt/runner/artifacts/screenshots/x.png" />')
      const rel = renderMarkdownUnsafe('<img alt="shot" src="artifacts/screenshots/x.png" />')
      assert.equal(abs, rel)
      assert.match(abs, /data-host-image-path="artifacts\/screenshots\/x\.png"/)
    })
  })

  it('renders the download-URL form identically and never leaks the session id', () => {
    withHostImagePolicy(() => {
      const url = renderMarkdownUnsafe(
        '<img alt="shot" src="https://host.example/v1/agents/session-abc123/artifacts/download?path=artifacts/screenshots/x.png" />',
      )
      const rel = renderMarkdownUnsafe('<img alt="shot" src="artifacts/screenshots/x.png" />')
      assert.equal(url, rel)
      assert.doesNotMatch(url, /session-abc123/)
    })
  })
})
