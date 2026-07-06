// Generate release notes for the version being cut, from the git commits made
// since the last release tag ("the last cut"). Used by
// `.github/workflows/release.yml` for both the GitHub Release body and the new
// CHANGELOG.md entry, and runnable locally via `npm run changelog -- <version>`
// to preview what the next release would contain.
//
// Commits are grouped by their Conventional-Commit type (feat/fix/docs/…);
// anything that doesn't parse as a known type lands under "Other Changes", and
// a `!` type-suffix or a "BREAKING CHANGE" trailer promotes the commit into a
// dedicated breaking-changes section. The "last cut" is the nearest reachable
// `v*` tag; on the very first release (no tags yet) the whole history is used.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const rawVersion = process.argv[2]
if (!rawVersion) {
  console.error('gen-changelog: usage: tsx scripts/gen-changelog.mts <version>')
  process.exit(1)
}
const version = rawVersion.replace(/^v/, '')
const tag = `v${version}`

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

/** The nearest reachable `v*` tag, or null when no release has been cut yet. */
function lastReleaseTag(): string | null {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v*']) || null
  } catch {
    return null
  }
}

/** owner/repo slug, from GITHUB_REPOSITORY in CI or package.json otherwise. */
function repoSlug(): string {
  const fromEnv = process.env['GITHUB_REPOSITORY']
  if (fromEnv) return fromEnv
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    repository?: { url?: string } | string
  }
  const url = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)
  return match?.[1] ?? 'copse-dev/streaming-markdown'
}

interface Commit {
  hash: string
  subject: string
  body: string
}

const previous = lastReleaseTag()
const range = previous ? `${previous}..HEAD` : 'HEAD'

// 0x1f separates fields, 0x1e separates records — neither occurs in commit text.
const log = git(['log', range, '--no-merges', '--pretty=format:%h%x1f%s%x1f%b%x1e'])
const commits: Commit[] = log
  .split('\x1e')
  .map((record) => record.trim())
  .filter(Boolean)
  .map((record) => {
    const [hash = '', subject = '', body = ''] = record.split('\x1f')
    return { hash: hash.trim(), subject: subject.trim(), body: body.trim() }
  })

interface Section {
  title: string
  types: string[]
}

// Rendered in this order; only non-empty sections are emitted.
const SECTIONS: Section[] = [
  { title: 'Features', types: ['feat'] },
  { title: 'Bug Fixes', types: ['fix'] },
  { title: 'Performance', types: ['perf'] },
  { title: 'Refactors', types: ['refactor'] },
  { title: 'Documentation', types: ['docs'] },
  { title: 'Tests', types: ['test'] },
  { title: 'Build System', types: ['build'] },
  { title: 'Continuous Integration', types: ['ci'] },
  { title: 'Chores', types: ['chore', 'style', 'revert'] },
]
const KNOWN_TYPES = new Set(SECTIONS.flatMap((s) => s.types))

const CONVENTIONAL = /^(?<type>\w+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s+(?<desc>.+)$/

interface Parsed {
  type: string | null
  breaking: boolean
  description: string
}

function parse(commit: Commit): Parsed {
  const match = CONVENTIONAL.exec(commit.subject)
  const breaking = match?.groups?.['breaking'] === '!' || /(^|\n)BREAKING[ -]CHANGE/.test(commit.body)
  if (!match?.groups) return { type: null, breaking, description: commit.subject }
  const type = match.groups['type']?.toLowerCase() ?? null
  return { type, breaking, description: match.groups['desc'] ?? commit.subject }
}

const breaking: string[] = []
const buckets = new Map<string, string[]>()
const other: string[] = []

const line = (commit: Commit, text: string): string => `- ${text} (\`${commit.hash}\`)`

for (const commit of commits) {
  const parsed = parse(commit)
  // A breaking commit is listed once, in its dedicated section — not also
  // duplicated verbatim into its type bucket / "Other Changes".
  if (parsed.breaking) {
    breaking.push(line(commit, parsed.description))
    continue
  }
  if (parsed.type && KNOWN_TYPES.has(parsed.type)) {
    const section = SECTIONS.find((s) => s.types.includes(parsed.type as string))
    if (!section) continue
    const list = buckets.get(section.title) ?? []
    list.push(line(commit, parsed.description))
    buckets.set(section.title, list)
  } else {
    // Non-conventional or unrecognised type: keep the full subject so context
    // like a `markdown:`/`streaming:` prefix isn't stripped away.
    other.push(line(commit, commit.subject))
  }
}

const out: string[] = []
if (breaking.length > 0) {
  out.push('### ⚠ BREAKING CHANGES', '', ...breaking, '')
}
for (const section of SECTIONS) {
  const list = buckets.get(section.title)
  if (list && list.length > 0) out.push(`### ${section.title}`, '', ...list, '')
}
if (other.length > 0) {
  out.push('### Other Changes', '', ...other, '')
}
if (out.length === 0) {
  out.push('_No notable changes._', '')
}

const slug = repoSlug()
const compare = previous
  ? `https://github.com/${slug}/compare/${previous}...${tag}`
  : `https://github.com/${slug}/commits/${tag}`
out.push(`**Full Changelog**: ${compare}`)

process.stdout.write(out.join('\n') + '\n')
