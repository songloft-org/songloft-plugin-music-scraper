import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const repository = process.env.GITHUB_REPOSITORY
const execute = (command, args) => execFileSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim()
const git = (...args) => execute('git', args)
const gh = (...args) => execute('gh', args)
const readJSON = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const writeJSON = (path, value) => writeFileSync(resolve(root, path), JSON.stringify(value, null, 2) + '\n')

function nextVersion(tags) {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date())
  const prefix = ['year', 'month', 'day'].map(part => date.find(value => value.type === part).value).join('.')
  const tagPrefix = `v${prefix}.`
  const revisions = tags
    .filter(tag => tag.startsWith(tagPrefix))
    .map(tag => tag.slice(tagPrefix.length))
    .filter(revision => /^\d{1,9}$/.test(revision))
    .map(Number)
  const revision = Math.max(-1, ...revisions) + 1
  if (revision > 999999999) throw new Error('Daily release sequence exhausted')
  return `${prefix}.${revision}`
}

function advertiseRelease(manifest, source) {
  const { version, download_url, entryHash, zipHash } = manifest
  for (let attempt = 0; attempt < 3; attempt++) {
    git('fetch', 'origin', 'main')
    git('checkout', '--detach', 'origin/main')
    const current = readJSON('plugin.json')
    if (current.releaseSource === source) return

    writeJSON('plugin.json', { ...current, version, download_url, entryHash, zipHash, releaseSource: source })
    writeJSON('package.json', { ...readJSON('package.json'), version })
    git('add', 'plugin.json', 'package.json')
    git('commit', '-m', `chore(release): bump to v${version}\n\nSource commit: ${source}`)
    try {
      git('push', 'origin', 'HEAD:main')
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

function publish() {
  if (process.env.GITHUB_REF !== 'refs/heads/main' || !repository) throw new Error('Release requires main')
  git('fetch', 'origin', 'main', '--tags')

  const head = git('rev-parse', 'HEAD')
  const current = JSON.parse(git('show', 'origin/main:plugin.json'))
  if (current.releaseSource === head) return
  if (head !== git('rev-parse', 'origin/main')) throw new Error('Run the release from the latest main commit')

  const manifest = readJSON('plugin.json')
  if (manifest.releaseSource && git('log', '-1', '--format=%B') ===
      `chore(release): bump to v${manifest.version}\n\nSource commit: ${manifest.releaseSource}`) {
    console.log(`Main already advertises v${manifest.version}`)
    return
  }

  git('config', 'user.name', 'github-actions[bot]')
  git('config', 'user.email', 'github-actions[bot]@users.noreply.github.com')
  const tags = git('tag', '--list').split('\n')
  const sourceMessage = `Source commit: ${head}`
  const asset = `${manifest.entryPath}.jsplugin.zip`
  const releases = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`)).flat()
  const previous = releases.find(release => !release.draft && !release.prerelease &&
    release.body?.split(/\r?\n/).includes(sourceMessage) && release.assets.some(file => file.name === asset))
  if (previous) {
    advertiseRelease(JSON.parse(git('show', `${previous.tag_name}:plugin.json`)), head)
    return
  }

  // Refer to the same source snapshot in the tag, manifest and release notes.
  const version = nextVersion(tags)
  const tag = `v${version}`

  manifest.version = version
  manifest.releaseSource = head
  manifest.download_url = `https://github.com/${repository}/releases/download/${tag}/${asset}`
  delete manifest.entryHash
  delete manifest.zipHash
  writeJSON('plugin.json', manifest)
  writeJSON('package.json', { ...readJSON('package.json'), version })

  execFileSync('bash', ['scripts/package.sh'], { cwd: root, stdio: 'inherit' })
  const built = readJSON('dist/_build/plugin.json')
  if (built.main !== 'main.jsc' || ![built.entryHash, built.zipHash].every(hash => /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Package is missing its bytecode or integrity hashes')
  }
  Object.assign(manifest, { entryHash: built.entryHash, zipHash: built.zipHash })
  writeJSON('plugin.json', manifest)

  git('add', 'plugin.json', 'package.json')
  git('commit', '-m', `chore(release): bump to ${tag}\n\n${sourceMessage}`)
  git('push', 'origin', `HEAD:refs/tags/${tag}`)
  console.log(gh('release', 'create', tag, `dist/${asset}`, '--repo', repository, '--verify-tag',
    '--latest', '--title', tag, '--notes', `曲库刮削插件 ${tag}\n\n${sourceMessage}`))
  advertiseRelease(manifest, head)
}

publish()
