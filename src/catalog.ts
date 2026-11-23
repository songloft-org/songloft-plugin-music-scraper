import { Converter } from 'opencc-js/t2cn'
import type { Song } from '@songloft/plugin-sdk'
import type { Candidate, Operation } from './types'

let converter: ReturnType<typeof Converter> | undefined
export function simplify(text: string): string {
  if (!/[\p{Script=Han}]/u.test(text) || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return text
  converter ??= Converter({ from: 't', to: 'cn' })
  return converter(text)
}

function normalized(text = '') {
  return simplify(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

const mbid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const versionMarkers = [
  /\blive\b|現場|现场|演唱會|演唱会/i,
  /\bacoustic\b|不插電|不插电/i,
  /\bdemo\b|試聽|试听/i,
  /\bremix\b|混音/i,
  /\bremaster(?:ed)?\b|重製|重制/i,
  /\binstrumental\b|伴奏|純音樂|纯音乐/i,
  /\bkaraoke\b|卡拉ok/i,
  /\b(?:edit|extended|short version)\b/i,
  /\bmono\b|單聲道|单声道/i,
  /\bstereo\b|立體聲|立体声/i,
  /\bcover\b|翻唱/i,
]

function versionOf(text: string) {
  return versionMarkers.map(re => Number(re.test(text))).join('')
}

type Release = { id: string; title: string; date?: string; status?: string }
type Recording = {
  id: string; title: string; disambiguation?: string; length?: number; isrcs?: string[]; releases?: Release[];
  'artist-credit'?: { name?: string; joinphrase?: string; artist?: { name?: string } }[]
}
type Matches = { candidates: Candidate[]; automatic: boolean; warning?: string }

function year(date = '') {
  return /^\d{4}(?:-|$)/.test(date) ? Number(date.slice(0, 4)) : undefined
}

function toCandidate(record: Recording, song: Song, method: Candidate['method']) {
  const credits = (record['artist-credit'] ?? []).map(credit => ({
    name: credit.name || credit.artist?.name || '', join: credit.joinphrase || '',
  })).filter(credit => credit.name)
  const releases = [...new Map((record.releases ?? []).filter(release => mbid.test(release.id) && release.title)
    .map(release => [release.id, release])).values()]
  const album = normalized(song.album)
  const matching = album ? releases.filter(release => normalized(release.title) === album) : []
  const release = matching.length === 1 ? matching[0] :
    !album && releases.length === 1 && releases[0].status === 'Official' ? releases[0] : undefined
  const isrcs = record.isrcs ?? []
  const candidate: Candidate = {
    id: record.id,
    title: simplify(record.title ?? ''),
    artists: credits.map(credit => simplify(credit.name)),
    album: release || matching[0] ? simplify((release ?? matching[0]).title) : undefined,
    albums: [...new Set(releases.map(item => simplify(item.title)))].slice(0, 5),
    release_id: release?.id,
    year: year(release?.date),
    version: record.disambiguation ? simplify(record.disambiguation) : undefined,
    duration: (record.length ?? 0) / 1000,
    isrc: isrcs.find(code => code.toUpperCase() === song.isrc?.toUpperCase()) ?? (isrcs.length === 1 ? isrcs[0] : undefined),
    method,
  }
  return { candidate, joined: credits.map(credit => credit.name + credit.join).join('') }
}

function queryTerm(value: string) {
  return '"' + value.replace(/["\\]/g, '\\$&') + '"'
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export class Catalog {
  private next = new Map<string, number>()

  private async request<T>(op: Operation, endpoint: string, query: URLSearchParams, form?: URLSearchParams): Promise<T> {
    const host = endpoint.split('/')[2]
    const interval = host === 'musicbrainz.org' ? 1100 : 400
    for (let attempt = 0; attempt < 3; attempt++) {
      op.check()
      const delay = (this.next.get(host) ?? 0) - Date.now()
      if (delay > 0) {
        let timer: number | undefined
        try {
          await op.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, delay) }))
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
      op.check()
      this.next.set(host, Date.now() + interval)
      let response: Awaited<ReturnType<typeof fetch>>
      try {
        response = await op.wait(fetch(endpoint + (query.toString() ? '?' + query.toString() : ''), {
          method: form ? 'POST' : 'GET',
          headers: {
            'User-Agent': 'SongloftMusicScraper/0.2 (https://github.com/songloft-org/songloft)',
            ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          },
          body: form?.toString(),
        }))
      } catch {
        op.check()
        throw new Error(host + ' 请求失败')
      }
      if (response.ok) {
        try {
          return await op.wait(response.json()) as T
        } catch {
          op.check()
          throw new Error(host + ' 返回了无效数据')
        }
      }
      if (![429, 502, 503, 504].includes(response.status)) throw new Error(host + ' HTTP ' + response.status)
      this.next.set(host, Date.now() + Math.max(interval, 1000 * 2 ** attempt))
    }
    throw new Error(host + ' 暂不可用')
  }

  async identify(op: Operation, song: Song, key: string): Promise<Matches> {
    let warning: string | undefined
    if (key && song.fingerprint && (song.fingerprint_duration ?? 0) > 0) {
      try {
        const matches = await this.fingerprint(op, song, key)
        if (matches.candidates.length) return matches
        warning = matches.warning
      } catch (error) {
        op.check()
        warning = errorText(error)
      }
    }
    try {
      const matches = await this.text(op, song)
      return { ...matches, warning }
    } catch (error) {
      op.check()
      return { candidates: [], automatic: false, warning: [warning, errorText(error)].filter(Boolean).join(' · ') }
    }
  }

  private async fingerprint(op: Operation, song: Song, key: string): Promise<Matches> {
    const duration = song.fingerprint_duration ?? 0
    const response = await this.request<{ status: string; results?: { score: number; recordings?: { id: string }[] }[] }>(
      op, 'https://api.acoustid.org/v2/lookup', new URLSearchParams(), new URLSearchParams({
        client: key, fingerprint: song.fingerprint ?? '', duration: String(Math.round(duration)), meta: 'recordings',
      }),
    )
    if (response.status !== 'ok') throw new Error('AcoustID 查询被拒绝')
    const results = response.results ?? []
    const top = Math.max(0, ...results.filter(item => item.recordings?.length).map(item => item.score))
    const ids = [...new Set(results.filter(item => item.score >= Math.max(.94, top - .025))
      .flatMap(item => item.recordings ?? []).map(item => item.id).filter(id => mbid.test(id)))]
    let warning = ids.length > 12 ? '指纹候选过多' : undefined
    const candidates: Candidate[] = []
    for (const id of ids.slice(0, 12)) {
      try {
        const record = await this.request<Recording>(op, 'https://musicbrainz.org/ws/2/recording/' + id,
          new URLSearchParams({ fmt: 'json', inc: 'artist-credits+releases+isrcs' }))
        const { candidate } = toCandidate(record, song, 'fingerprint')
        if (candidate.id !== id || !candidate.title || !candidate.artists.length) {
          warning = 'MusicBrainz 录音信息不完整'
          continue
        }
        if (!candidate.duration || Math.abs(candidate.duration - duration) <= 5) candidates.push(candidate)
      } catch (error) {
        op.check()
        warning = errorText(error)
      }
    }
    const match = candidates[0]
    return {
      candidates, warning,
      automatic: !warning && candidates.length === 1 &&
        versionOf(song.title + ' ' + (song.album ?? '')) === versionOf(match.title + ' ' + (match.version ?? '')) &&
        (!match.version || !!song.isrc && match.isrc?.toUpperCase() === song.isrc.toUpperCase()),
    }
  }

  private async text(op: Operation, song: Song): Promise<Matches> {
    const title = normalized(song.title)
    const artist = normalized(song.artist)
    const duration = song.duration ?? 0
    if (!title || !artist || duration <= 0) return { candidates: [], automatic: false }
    const artistName = song.artist ?? ''
    const terms = (name: string, credit: string) => 'recording:' + queryTerm(name) + ' AND artist:' + queryTerm(credit)
    const original = terms(song.title, artistName)
    const converted = terms(simplify(song.title), simplify(artistName))
    const query = original === converted ? original : '(' + original + ') OR (' + converted + ')'
    const reply = await this.request<{ count?: number; recordings?: Recording[] }>(op,
      'https://musicbrainz.org/ws/2/recording', new URLSearchParams({ fmt: 'json', limit: '50', query }))
    const candidates: Candidate[] = []
    const seen = new Set<string>()
    let best: Candidate | undefined
    let rank = 0
    let tied = false
    const localVersion = versionOf(song.title + ' ' + (song.album ?? ''))
    for (const record of reply.recordings ?? []) {
      const { candidate, joined } = toCandidate(record, song, 'text')
      if (!mbid.test(candidate.id) || seen.has(candidate.id) || normalized(candidate.title) !== title ||
        (normalized(joined) !== artist && normalized(candidate.artists.join('')) !== artist) ||
        candidate.duration && Math.abs(candidate.duration - duration) > 8) continue
      seen.add(candidate.id)
      candidates.push(candidate)
      const version = versionOf([candidate.title, candidate.version, candidate.album].join(' '))
      if (version !== localVersion || !candidate.duration || Math.abs(candidate.duration - duration) > 3) continue
      const confidence = song.isrc && song.isrc.toUpperCase() === candidate.isrc?.toUpperCase() ? 2 :
        (!candidate.version && candidate.album && normalized(candidate.album) === normalized(song.album)) ? 1 : 0
      if (confidence > rank) {
        best = candidate
        rank = confidence
        tied = false
      } else if (confidence > 0 && confidence === rank) tied = true
    }
    if (best && !tied && (reply.count ?? Infinity) <= (reply.recordings?.length ?? 0)) return { candidates: [best], automatic: true }
    return { candidates, automatic: false }
  }

  async details(op: Operation, candidate: Candidate): Promise<Candidate> {
    if (!candidate.release_id || !mbid.test(candidate.release_id)) return candidate
    const release = await this.request<{ date?: string; media?: {
      'track-count'?: number; tracks?: { position: number; recording?: { id: string } }[]
    }[] }>(op, 'https://musicbrainz.org/ws/2/release/' + candidate.release_id,
      new URLSearchParams({ fmt: 'json', inc: 'recordings' }))
    const tracks = (release.media ?? []).flatMap(medium => (medium.tracks ?? [])
      .filter(track => track.recording?.id === candidate.id && track.position > 0)
      .map(track => String(track.position) + (medium['track-count'] ? '/' + medium['track-count'] : '')))
    return { ...candidate, year: year(release.date) ?? candidate.year, track: tracks.length === 1 ? tracks[0] : undefined }
  }
}
