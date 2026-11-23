import { createRouter, jsonResponse, type HTTPRequest } from '@songloft/plugin-sdk'
import { Jobs } from './jobs'
import type { Preset } from './types'

const songs = songloft.songs as unknown as ConstructorParameters<typeof Jobs>[0]
const requiredMethods = [
  'localLibrary',
  'inspectLocalFile',
  'ensureFingerprint',
  'lookupMetadata',
  'writeLocalMetadata',
  'cancelLocalOperation',
] as const satisfies readonly (keyof typeof songs)[]
const missingMethods = requiredMethods.filter(method => typeof songs?.[method] !== 'function')
const compatible = missingMethods.length === 0
const hostError = '当前后端缺少曲库刮削接口，请更新后端构建'
const jobs = new Jobs(songs)
const router = createRouter()

router.get('/api/status', () => respond(async () => ({
  compatible,
  ...(compatible ? await jobs.capabilities() : { reason: hostError, missing_methods: missingMethods }),
}), false))
router.get('/api/folders', () => respond(() => jobs.folders()))
router.get('/api/job', (request) => {
  const query = new URLSearchParams(request.query)
  const offset = Math.max(0, Math.trunc(Number(query.get('offset')) || 0))
  return respond(() => jobs.status(offset, query.get('filter') ?? ''))
})
router.post('/api/job', (request) => respond(() => jobs.start(body(request) as Partial<Preset>)))
router.post('/api/job/cancel', (request) => respond(() => jobs.cancel(String(body(request).job_id ?? ''))))
router.post('/api/job/confirm', (request) => respond(() => {
  const data = body(request)
  return jobs.confirm(String(data.job_id ?? ''), Number(data.song_id), String(data.candidate_id ?? ''))
}))
router.post('/api/acoustid', (request) => respond(() => jobs.setKey(body(request).key)))

function body(request: HTTPRequest): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(request.body ?? ''))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // The runtime supplies the request body as a UTF-8 string.
  }
  throw new Error('无效的请求数据')
}

async function respond(action: () => Promise<unknown>, needsHost = true) {
  try {
    if (needsHost && !compatible) throw new Error(hostError)
    return jsonResponse(await action())
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
}

globalThis.onHTTPRequest = async request => router.handle(request)
globalThis.onDeinit = () => jobs.stop()
