// Prepend a release's notes to CHANGELOG.md (Keep-a-Changelog style), inserting
// the new `## [version] - date` entry directly beneath the file's intro and
// above the previous release. Driven by `.github/workflows/release.yml`, which
// passes the notes produced by `gen-changelog.mts`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , rawVersion, date, notesPath] = process.argv
if (!rawVersion || !date || !notesPath) {
  console.error('update-changelog: usage: tsx scripts/update-changelog.mts <version> <date> <notes-file>')
  process.exit(1)
}
const version = rawVersion.replace(/^v/, '')

const ROOT = resolve(import.meta.dirname, '..')
const CHANGELOG = resolve(ROOT, 'CHANGELOG.md')

const HEADER = `# Changelog

All notable changes to this project are documented in this file. Each entry is
generated at release time from the commits since the previous tag. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`

const notes = readFileSync(resolve(ROOT, notesPath), 'utf8').trim()
const entry = `## [${version}] - ${date}\n\n${notes}\n`

const existing = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : `${HEADER}\n`

// Insert the new entry before the first existing release heading; if there are
// none yet, place it after the intro (i.e. at the end of the file).
const firstEntry = existing.search(/^## \[/m)
const updated =
  firstEntry === -1
    ? `${existing.trimEnd()}\n\n${entry}`
    : `${existing.slice(0, firstEntry)}${entry}\n${existing.slice(firstEntry)}`

writeFileSync(CHANGELOG, updated.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n')
console.log(`update-changelog: added ${version} entry to CHANGELOG.md`)
