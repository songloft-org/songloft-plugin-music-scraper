import { Catalog, simplify } from './catalog'
import { foldersFor, pathKey, selectTracks, targetFor } from './paths'
import type { Candidate, FileInfo, IndexedTrack, Job, Library, Lyrics, Operation, Preset, RecordEntry, Result } from './types'

type LocalOperation = { operation_id: string }
type Fingerprint = { fingerprint?: string; fingerprint_duration?: number }
type Media = { lyrics?: Lyrics; cover_url?: string }
type LocalLibraryAPI = {
  localLibrary(params?: { include_tracks: false }): Promise<Library>
  inspectLocalFile(params: LocalOperation & { song_id: number }): Promise<FileInfo | Pick<Result, 'state' | 'detail'>>
  ensureFingerprint(params: LocalOperation & { song_id: number }): Promise<Fingerprint>
  lookupMetadata(params: LocalOperation & Candidate & { fingerprint?: string; lookup_lyrics: boolean; lookup_cover: boolean }): Promise<Media>
  writeLocalMetadata(params: LocalOperation & Candidate & Media & { song_id: number; revision: string; target_path: string }): Promise<Pick<Result, 'state' | 'detail' | 'target' | 'warning'>>
  cancelLocalOperation(id: string): Promise<void>
}

const jobKey = 'latest-job.json'
const keyName = 'acoustid-key'
const resultPrefix = 'result-'
const recordKey = (id: string, song: number) => resultPrefix + id + '-' + song + '.json'
const active = (state: string) => state === 'running' || state === 'confirming' || state === 'cancelling'

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

class Run implements Operation {
  cancelled = false
  private interrupt?: () => void
  private keepAlive = setInterval(() => {}, 60_000)
  readonly args: LocalOperation

  constructor(readonly job: Job, private host: LocalLibraryAPI) {
    this.args = { operation_id: job.id + '-' + Date.now().toString(36) }
  }

  check() {
    if (this.cancelled) throw new Error('任务已取消')
  }

  async wait<T>(request: Promise<T>) {
    if (this.cancelled) {
      void request.catch(() => {})
      this.check()
    }
    const interrupted = new Promise<never>((_, reject) => {
      this.interrupt = () => reject(new Error('任务已取消'))
    })
    try {
      return await Promise.race([request, interrupted])
    } finally {
      this.interrupt = undefined
    }
  }

  async cancel() {
    this.cancelled = true
    this.interrupt?.()
    await this.host.cancelLocalOperation(this.args.operation_id)
  }

  close() {
    clearInterval(this.keepAlive)
  }
}

export class Jobs {
  private job: Job | null = null
  private records = new Map<number, RecordEntry>()
  private catalog = new Catalog()
  private loaded?: Promise<void>
  private run?: Run
  private starting = false
  private acoustid = ''

  constructor(private host: LocalLibraryAPI) {}

  initialize() {
    return this.loaded ??= this.load().catch(error => {
      this.loaded = undefined
      throw error
    })
  }

  private async load() {
    this.acoustid = (await songloft.storage.get(keyName)) as string | null ?? ''
    this.job = (await songloft.storage.get(jobKey)) as Job | null
    this.records.clear()
    if (!this.job) return
    const prefix = resultPrefix + this.job.id + '-'
    for (const key of await songloft.storage.keys()) {
      if (!key.startsWith(prefix)) continue
      const entry = (await songloft.storage.get(key)) as RecordEntry | null
      if (!entry) continue
      if (entry.result.state === 'writing') {
        entry.result.state = 'interrupted'
        entry.result.detail = '写入期间插件已重载，请检查源文件和目标路径'
      }
      this.records.set(entry.result.song_id, entry)
    }
    if (active(this.job.state)) {
      this.job.state = 'interrupted'
      this.job.checked = Math.max(this.job.checked, this.records.size)
      await this.saveJob()
    }
  }

  private saveJob() {
    return songloft.storage.set(jobKey, this.job)
  }

  private async save(entry: RecordEntry) {
    this.records.set(entry.result.song_id, entry)
    await songloft.storage.set(recordKey(this.job!.id, entry.result.song_id), entry)
  }

  async capabilities() {
    await this.initialize()
    const library = await this.host.localLibrary({ include_tracks: false })
    return { acoustid_configured: !!this.acoustid, fingerprint_available: library.fingerprint_available }
  }

  async setKey(value: unknown) {
    await this.initialize()
    if (this.run || this.starting) throw new Error('刮削期间无法修改 AcoustID 配置')
    if (typeof value !== 'string' || value.length > 200 || /[\s\u0000-\u001f]/.test(value.trim())) {
      throw new Error('无效的 AcoustID 应用 key')
    }
    const key = value.trim()
    if (key) await songloft.storage.set(keyName, key)
    else await songloft.storage.delete(keyName)
    this.acoustid = key
    return { acoustid_configured: !!this.acoustid }
  }

  async folders() {
    const library = await this.host.localLibrary()
    return { root: library.root, folders: foldersFor(library.tracks) }
  }

  async status(offset: number, filter: string) {
    await this.initialize()
    const counts: Record<string, number> = {}
    const results: Result[] = []
    for (const { result } of this.records.values()) {
      counts[result.state] = (counts[result.state] ?? 0) + 1
      if (!filter || result.state === filter) results.push(result)
    }
    return { job: this.job, processed: this.records.size, counts, results: results.slice(offset, offset + 40) }
  }

  async start(input: Partial<Preset>) {
    await this.initialize()
    if (this.run || this.starting) throw new Error('a scraper task is already running')
    this.starting = true
    try {
      const layout = input.layout ?? 'original'
      const filename = input.filename ?? 'artist-title'
      if (!Array.isArray(input.directories) || !input.directories.length || input.directories.some(dir => typeof dir !== 'string') ||
        !['original', 'flat', 'artist-album'].includes(layout) || !['artist-title', 'title', 'original'].includes(filename)) {
        throw new Error('请选择目录和有效的刮削预设')
      }
      const preset = { directories: [...new Set(input.directories)].sort(), layout, filename }
      const library = await this.host.localLibrary()
      const work = selectTracks(library.tracks, preset.directories)
      if (!work.length) throw new Error('the selected directories contain no indexed tracks')
      const job = { id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), state: 'running',
        preset, total: work.length, checked: 0 }
      await songloft.storage.set(jobKey, job)
      this.job = job
      this.records.clear()
      const run = new Run(job, this.host)
      this.run = run
      void this.process(run, work, library.fingerprint_available)
      return job
    } finally {
      this.starting = false
    }
  }

  async cancel(id: string) {
    await this.initialize()
    if (!this.run || this.run.job.id !== id) throw new Error('任务已结束')
    this.run.job.state = 'cancelling'
    await this.run.cancel()
    return { accepted: true }
  }

  async confirm(id: string, songId: number, candidateId: string) {
    await this.initialize()
    if (this.run || this.starting) throw new Error('a scraper task is already running')
    const record = this.records.get(songId)
    const candidate = record?.result.candidates?.find(item => item.id === candidateId)
    if (!this.job || this.job.id !== id || record?.result.state !== 'review' || !record.file || !candidate) {
      throw new Error('该曲目或候选已失效')
    }
    const previous = this.job.state
    this.job.state = 'confirming'
    const run = new Run(this.job, this.host)
    this.run = run
    void this.complete(run, previous, async () => {
      await this.saveJob()
      const target = targetFor(run.job.preset, record.selection!, record.file!, candidate)
      await this.write(run, record, candidate, target)
      return previous
    })
    return { accepted: true }
  }

  stop() {
    const run = this.run
    if (run) {
      run.close()
      void run.cancel().catch(() => {})
    }
  }

  private async complete(run: Run, cancelledState: string, execute: () => Promise<string>) {
    try {
      run.job.state = await execute()
    } catch (error) {
      run.job.state = run.cancelled ? cancelledState : 'failed'
      if (!run.cancelled) run.job.detail = errorText(error)
    } finally {
      run.close()
      try {
        await this.saveJob()
      } catch {
        run.job.state = 'failed'
        run.job.detail = 'could not save scraper results'
      }
      this.run = undefined
    }
  }

  private process(run: Run, work: { track: IndexedTrack; selection: string }[], fingerprintAvailable: boolean) {
    return this.complete(run, 'cancelled', async () => {
      const prefix = resultPrefix + run.job.id + '-'
      for (const key of await songloft.storage.keys()) {
        run.check()
        if (key.startsWith(resultPrefix) && !key.startsWith(prefix)) await songloft.storage.delete(key)
      }
      const pending: { record: RecordEntry; target: string; match: Candidate }[] = []
      const targets = new Map<string, number>()
      for (const item of work) {
        run.check()
        const found = await this.identify(run, item, fingerprintAvailable)
        run.check()
        run.job.checked++
        if (found.target && found.match) {
          pending.push({ record: found.record, target: found.target, match: found.match })
          const key = pathKey(found.target)
          targets.set(key, (targets.get(key) ?? 0) + 1)
        } else {
          await this.save(found.record)
        }
      }
      for (const { record, target, match } of pending) {
        run.check()
        if (targets.get(pathKey(target))! > 1) {
          await this.save({ result: { ...record.result, match, candidates: undefined, target, state: 'conflict',
            detail: 'multiple selected tracks would have the same target' } })
        } else {
          await this.write(run, record, match, target)
        }
      }
      return run.cancelled ? 'cancelled' : 'completed'
    })
  }

  private async identify(run: Run, { track, selection }: { track: IndexedTrack; selection: string }, fingerprintAvailable: boolean) {
    const result: Result = { song_id: track.id, path: track.file_path, state: 'error' }
    const record: RecordEntry = { result }
    try {
      const file = await this.host.inspectLocalFile({ ...run.args, song_id: track.id })
      run.check()
      if ('state' in file) {
        Object.assign(result, file)
        return { record }
      }
      if (file.song.file_path !== track.file_path || file.relative_path !== track.relative_path) {
        result.state = 'changed'
        result.detail = 'the song or its path changed'
        return { record }
      }
      if (!file.song.fingerprint && fingerprintAvailable) {
        try {
          Object.assign(file.song, await this.host.ensureFingerprint({ ...run.args, song_id: track.id }))
        } catch (error) {
          run.check()
          result.warning = errorText(error)
        }
      }
      const match = await this.catalog.identify(run, file.song, this.acoustid)
      run.check()
      result.warning = [result.warning, match.warning].filter(Boolean).join(' · ') || undefined
      if (!match.candidates.length) {
        result.state = 'unmatched'
        result.detail = 'no reliable recording found'
        return { record }
      }
      record.file = file
      record.selection = selection
      if (match.automatic) {
        return { record, target: targetFor(run.job.preset, selection, file, match.candidates[0]), match: match.candidates[0] }
      }
      result.candidates = match.candidates
      result.state = 'review'
      result.detail = 'choose a recording to write its tags'
      return { record }
    } catch (error) {
      run.check()
      result.detail = errorText(error)
      return { record }
    }
  }

  private async write(run: Run, record: RecordEntry, candidate: Candidate, target: string) {
    const file = record.file!
    const prior = record.result
    const warnings = [prior.warning]
    let match = candidate
    try {
      match = await this.catalog.details(run, match)
    } catch (error) {
      run.check()
      warnings.push(errorText(error))
    }
    let media: Media = {}
    const wantsCover = file.lookup_cover && !!match.album
    if (file.lookup_lyrics || wantsCover) {
      try {
        media = await this.host.lookupMetadata({
          ...run.args, ...match, duration: match.duration || file.song.duration || 0,
          fingerprint: file.song.fingerprint, lookup_lyrics: file.lookup_lyrics, lookup_cover: wantsCover,
        })
      } catch (error) {
        run.check()
        warnings.push(errorText(error))
      }
      if (media.lyrics) {
        const { lyric, tlyric, lxlyric, rlyric } = media.lyrics
        media.lyrics = { lyric: lyric && simplify(lyric), tlyric: tlyric && simplify(tlyric), lxlyric: lxlyric && simplify(lxlyric), rlyric }
      }
    }
    run.check()
    try {
      await this.save({ result: { ...prior, target, match, candidates: undefined, state: 'writing' } })
      run.check()
      const written = await this.host.writeLocalMetadata({
        ...run.args, ...match, ...media, song_id: prior.song_id, revision: file.revision, target_path: target,
      })
      if (run.cancelled && written.state !== 'written') {
        if (prior.state === 'review') await this.save(record)
        else await this.save({ result: { ...prior, state: 'cancelled' } })
        run.check()
      }
      await this.save({ result: { ...prior, ...written, match, candidates: undefined,
        warning: [...warnings, written.warning].filter(Boolean).join(' · ') || undefined } })
    } catch (error) {
      if (run.cancelled) {
        await this.save(prior.state === 'review' ? record : { result: { ...prior, state: 'cancelled' } })
        run.check()
      }
      await this.save({ result: { ...prior, target, match, candidates: undefined, state: 'error', detail: errorText(error) } })
    }
  }
}
