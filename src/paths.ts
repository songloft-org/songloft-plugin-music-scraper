import type { Candidate, FileInfo, IndexedTrack, Preset } from './types'

function parent(path: string) {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '.' : path.slice(0, slash)
}

export function foldersFor(tracks: IndexedTrack[]) {
  const folders = new Map<string, { path: string; count: number; sample: { path: string; title: string; artist: string; album: string } }>()
  for (const track of tracks) {
    for (let dir = parent(track.relative_path); ; dir = parent(dir)) {
      const folder = folders.get(dir)
      if (folder) folder.count++
      else folders.set(dir, { path: dir, count: 1,
        sample: { path: track.relative_path, title: track.title, artist: track.artist ?? '', album: track.album ?? '' } })
      if (dir === '.') break
    }
  }
  return [...folders.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

export function selectTracks(tracks: IndexedTrack[], directories: string[]) {
  const selected = new Set(directories)
  return tracks.flatMap(track => {
    let selection: string | undefined
    for (let dir = parent(track.relative_path); ; dir = parent(dir)) {
      if (selected.has(dir)) selection = dir
      if (dir === '.') break
    }
    return selection === undefined ? [] : [{ track, selection }]
  })
}

function component(value: string) {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]+/g, '_').replace(/ +/g, ' ').replace(/[.\-_ ]+$/, '')
  const portable = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(cleaned) ? '_' + cleaned : cleaned
  let length = 0
  let result = ''
  for (const char of portable) {
    const point = char.codePointAt(0) ?? 0
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (length > 200) break
    result += char
  }
  return result.replace(/[. ]+$/, '')
}

export function targetFor(preset: Preset, selection: string, file: FileInfo, match: Candidate): string {
  const join = (...parts: string[]) => parts.filter(part => part && part !== '.').join('/')
  const { song, protected: fixed, relative_path: path } = file
  const artists = fixed.includes('artist') ? (song.artist ?? '').split(' & ').filter(Boolean) : match.artists
  let directory = parent(path)
  if (preset.layout === 'flat') directory = selection
  if (preset.layout === 'artist-album') {
    const album = component((fixed.includes('album') ? song.album : match.album) ?? '')
    const artist = component(artists[0] ?? '')
    if (artist && album) directory = join(selection, artist, album)
  }
  let name = path.slice(path.lastIndexOf('/') + 1)
  if (preset.filename !== 'original') {
    const title = fixed.includes('title') ? song.title : match.title
    const stem = component(preset.filename === 'artist-title' && artists.length ? artists.join('&') + '-' + title : title)
    if (!stem) throw new Error('匹配结果无法生成文件名')
    const extension = name.lastIndexOf('.')
    name = stem + (extension < 0 ? '' : name.slice(extension))
  }
  return join(directory, name)
}

export function pathKey(path: string) {
  return path.normalize('NFC').toUpperCase()
}
