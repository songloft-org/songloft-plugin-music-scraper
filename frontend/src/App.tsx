import { useEffect, useRef, useState } from '@lynx-js/react'
import { apiGet, apiPost, getFrameId, getTheme, onThemeChange } from '@songloft/lynx-plugin-sdk'
import './style.css'

type Folder = {
  path: string
  count: number
  sample: { path: string; title: string; artist: string; album: string }
}
type Capabilities = { compatible: boolean; reason?: string; acoustid_configured?: boolean; fingerprint_available?: boolean }
type Layout = 'original' | 'flat' | 'artist-album'
type Filename = 'artist-title' | 'title' | 'original'
type Preset = { directories: string[]; layout: Layout; filename: Filename }
type Candidate = {
  id: string; title: string; artists: string[]; album?: string; albums?: string[];
  version?: string; duration: number; method: 'text' | 'fingerprint'
}
type Result = {
  song_id: number; path: string; target?: string; state: string; detail?: string;
  warning?: string; match?: Candidate; candidates?: Candidate[]
}
type Job = { id: string; state: string; preset: Preset; total: number; checked: number; detail?: string }
type JobStatus = { job: Job | null; processed: number; counts: Record<string, number>; results: Result[] }

const labels: Record<string, string> = {
  writing: '正在写入',
  written: '已写入', review: '待确认', unmatched: '未匹配', conflict: '路径冲突',
  shared: '共享音频', changed: '源文件变更', unsupported: '标签不支持', error: '处理失败',
  completed: '刮削完成', cancelled: '已取消', interrupted: '任务已中断', failed: '任务失败',
  running: '识别录音', confirming: '正在写入所选版本', cancelling: '正在取消',
}

const reasons: Record<string, string> = {
  'the song or its path changed': '歌曲或文件路径已变更',
  'source file changed since its last library scan': '文件在上次曲库扫描后发生了变更',
  'source file changed after matching': '文件在匹配后发生了变更',
  'source file changed before publication': '文件在写入前发生了变更',
  'source file is missing or is not a regular file': '源文件不存在或无法安全访问',
  'CUE or shared audio file': 'CUE 分轨或多条曲目共用一个音频文件',
  'multiple selected tracks would have the same target': '多首所选歌曲的目标路径相同',
  'no reliable recording found': '未找到可用的录音版本',
  'choose a recording to write its tags': '选择一个版本以写入标签',
  'could not save scraper results': '保存刮削记录失败',
  'a scraper task is already running': '已有刮削任务在运行',
  'a library scan is in progress': '曲库扫描正在进行',
  'the selected directories contain no indexed tracks': '所选目录内没有已入库的曲目',
}

const layouts: ReadonlyArray<[Layout, string]> = [
  ['original', '保持原目录'], ['flat', '平铺'], ['artist-album', '歌手/专辑'],
]
const filenames: ReadonlyArray<[Filename, string]> = [
  ['artist-title', '歌手-歌名'], ['title', '歌名'], ['original', '保留原名'],
]
const pageSize = 40

function activeJob(state?: string) {
  return state === 'running' || state === 'confirming' || state === 'cancelling'
}

function isUnder(path: string, dir: string) {
  return path === dir || dir === '.' || path.startsWith(dir + '/')
}

function safeComponent(value: string) {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/ +/g, ' ').replace(/[.\-_ ]+$/, '')
}

function pathExample(folder: Folder, layout: Layout, filename: Filename) {
  const sample = folder.sample
  const slash = sample.path.lastIndexOf('/')
  const original = sample.path.slice(slash + 1)
  const dot = original.lastIndexOf('.')
  const suffix = dot < 0 ? '' : original.slice(dot)
  const artists = sample.artist.split(' & ').map(artist => artist.trim()).filter(Boolean)
  const title = filename === 'artist-title' && artists.length ? artists.join('&') + '-' + sample.title : sample.title
  const name = filename === 'original' || !safeComponent(title) ? original : safeComponent(title) + suffix
  const selected = folder.path === '.' ? '' : folder.path
  let dir = slash < 0 ? '' : sample.path.slice(0, slash)
  if (layout === 'flat') dir = selected
  if (layout === 'artist-album' && safeComponent(artists[0] ?? '') && safeComponent(sample.album)) {
    dir = [selected, safeComponent(artists[0]), safeComponent(sample.album)].filter(Boolean).join('/')
  }
  return dir ? dir + '/' + name : name
}

function durationText(seconds: number) {
  if (!seconds) return '时长未知'
  const rounded = Math.round(seconds)
  return Math.floor(rounded / 60) + ':' + String(rounded % 60).padStart(2, '0')
}

function trackName(path: string) {
  return path.split(/[\\/]/).pop() ?? path
}

function Button(props: { label: string; onTap: () => void; selected?: boolean; primary?: boolean; disabled?: boolean; kind?: string }) {
  return (
    <view
      className={['button', props.kind, props.selected && 'selected', props.primary && 'primary', props.disabled && 'disabled'].filter(Boolean).join(' ')}
      accessibility-label={props.label}
      accessibility-element={true}
      accessibility-traits={props.disabled ? 'disabled' : 'button'}
      aria-label={props.label}
      aria-disabled={props.disabled}
      bindtap={props.disabled ? undefined : props.onTap}
    >
      <text className="button-text">{props.label}</text>
    </view>
  )
}

export function App() {
  const [theme, setTheme] = useState(() => getTheme())
  const [width, setWidth] = useState(0)
  const measured = useRef(false)
  const [capabilities, setCapabilities] = useState<Capabilities>()
  const [showKey, setShowKey] = useState(false)
  const keyDraft = useRef('')
  const [library, setLibrary] = useState<{ root: string; folders: Folder[] }>()
  const [selected, setSelected] = useState<string[]>([])
  const [layout, setLayout] = useState<Layout>('original')
  const [filename, setFilename] = useState<Filename>('artist-title')
  const [status, setStatus] = useState<JobStatus>()
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [folderPath, setFolderPath] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [pollError, setPollError] = useState('')
  const [reload, setReload] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const hydrated = useRef(false)

  useEffect(() => onThemeChange(setTheme), [])
  useEffect(() => {
    const measure = () => {
      if (measured.current) return
      lynx.createSelectorQuery().select('#scraper-root').invoke({
        method: 'boundingClientRect',
        success: (rect: { width?: number }) => {
          if (!measured.current && rect?.width && rect.width > 0) {
            measured.current = true
            setWidth(rect.width)
          }
        },
      }).exec()
    }
    const timer = setTimeout(measure, 0)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    let live = true
    setLoadError('')
    void apiGet<Capabilities>('/api/status').then(async (info) => {
      if (!live) return
      setCapabilities(info)
      if (!info.compatible) return
      const folders = await apiGet<{ root: string; folders: Folder[] }>('/api/folders')
      if (live) setLibrary(folders)
    }).catch(error => { if (live) setLoadError(readError(error)) })
    return () => { live = false }
  }, [reload])

  useEffect(() => {
    if (!capabilities?.compatible) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      let delay = 3500
      try {
        const next = await apiGet<JobStatus>(`/api/job?offset=${page * pageSize}&filter=${filter}`)
        if (!live) return
        if (!hydrated.current) {
          hydrated.current = true
          if (next.job && activeJob(next.job.state)) {
            setSelected(next.job.preset.directories)
            setLayout(next.job.preset.layout)
            setFilename(next.job.preset.filename)
          }
        }
        setStatus(next)
        setPollError('')
        if (page > 0 && next.results.length === 0) setPage(page - 1)
        if (activeJob(next.job?.state)) delay = 850
      } catch (error) {
        if (live) setPollError(readError(error))
      }
      if (live) timer = setTimeout(poll, delay)
    }
    void poll()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [capabilities, page, filter, refresh])

  const folders = library?.folders ?? []
  const chosen = folders.filter(folder => selected.includes(folder.path) &&
    !selected.some(parent => parent !== folder.path && isUnder(folder.path, parent)))
  const count = chosen.reduce((total, folder) => total + folder.count, 0)
  const example = chosen[0] ? pathExample(chosen[0], layout, filename) : ''
  const job = status?.job
  const isActive = activeJob(job?.state)
  const isLocked = isActive || busy
  const resultCount = filter ? status?.counts[filter] ?? 0 : status?.processed ?? 0

  function toggleFolder(path: string) {
    if (!isLocked) setSelected(before => before.includes(path) ? before.filter(dir => dir !== path) : [...before, path])
  }

  async function action<T = unknown>(path: string, body: unknown, onSuccess?: (result: T) => void) {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setActionError('')
    try {
      const result = await apiPost<T>(path, body)
      onSuccess?.(result)
      setRefresh(value => value + 1)
    } catch (error) {
      setActionError(readError(error))
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const className = ['scraper', theme, width >= 600 && 'wide', width >= 960 && 'table'].filter(Boolean).join(' ')
  const frameId = getFrameId()
  return (
    <view
      id="scraper-root"
      className={className}
      flatten={false}
      bindlayoutchange={event => {
        const next = event.detail?.width
        if (typeof next === 'number' && next > 0) {
          measured.current = true
          setWidth(next)
        }
      }}
    >
      <view className="header">
        {(!frameId || frameId === 'plugin-web-fallback') && <text className="title">曲库刮削</text>}
        <text className="host-status">
          {capabilities?.compatible
            ? '宿主已兼容'
            : capabilities ? (capabilities.reason ?? '当前后端缺少曲库刮削接口') : '正在检查宿主'}
          {capabilities?.compatible && (capabilities.acoustid_configured
            ? capabilities.fingerprint_available ? ' · AcoustID 已配置' : ' · AcoustID 已配置，指纹提取不可用'
            : ' · AcoustID 未配置')}
        </text>
        {capabilities?.compatible && <view className="key-settings">
          <Button label={showKey ? '关闭设置' : '设置 AcoustID'} disabled={isLocked} onTap={() => {
            keyDraft.current = ''
            setShowKey(!showKey)
          }} />
          {showKey && <view className="key-form">
            <input
              className="key-input"
              type="password"
              maxlength={200}
              placeholder="输入应用 key，留空清除"
              bindinput={event => { keyDraft.current = event.detail?.value ?? '' }}
            />
            <Button label="保存" disabled={isLocked} onTap={() => {
              void action<{ acoustid_configured: boolean }>('/api/acoustid', { key: keyDraft.current }, result => {
                keyDraft.current = ''
                setCapabilities(info => info && { ...info, acoustid_configured: result.acoustid_configured })
                setShowKey(false)
              })
            }} />
          </view>}
        </view>}
        {loadError && <view className="inline-error">
          <text className="error-text">{loadError}</text>
          <Button label="重试" onTap={() => setReload(value => value + 1)} />
        </view>}
      </view>
      {capabilities?.compatible && <view className="content">
        <view className="folders panel">
          <view className="panel-heading">
            <text className="heading">目录</text>
            <text className="muted">包含子目录</text>
          </view>
          <scroll-view className="folder-scroll" scroll-y>
            {folders.map(folder => {
              const checked = selected.includes(folder.path)
              const inherited = !checked && selected.some(parent => isUnder(folder.path, parent))
              const display = folder.path === '.' ? '音乐根目录' : folder.path
              return (
                <view key={folder.path} className="folder">
                  <view className={checked || inherited ? 'folder-row checked-row' : 'folder-row'}
                    accessibility-element={true} accessibility-role-description="checkbox"
                    accessibility-label={display + (checked || inherited ? '，已选' : '，未选')}
                    aria-checked={checked || inherited}
                    aria-label={display} bindtap={() => toggleFolder(folder.path)}>
                    <view className={checked || inherited ? 'checkbox checked' : 'checkbox'}>
                      {checked && <text className="check-text">✓</text>}
                      {inherited && <text className="check-text">–</text>}
                    </view>
                    <text className="folder-name clip" text-maxline="1">{display}</text>
                    <text className="muted">{folder.count}</text>
                  </view>
                  <Button label="路径" kind="path-button" onTap={() => setFolderPath(folderPath === folder.path ? '' : folder.path)} />
                  {folderPath === folder.path && <text className="path-detail">
                    {folder.path === '.' ? library?.root : `${library?.root}/${folder.path}`}
                  </text>}
                </view>
              )
            })}
            {folders.length === 0 && <text className="empty">{library ? '曲库没有已入库的本地曲目' : '正在读取目录'}</text>}
          </scroll-view>
        </view>
        <view className="workspace">
          <view className="presets panel">
            <view className="preset">
              <text className="field-label">目录结构</text>
              <view className="choices">{layouts.map(([value, label]) =>
                <Button key={value} label={label} onTap={() => setLayout(value)} selected={layout === value} disabled={isLocked} />
              )}</view>
            </view>
            <view className="preset">
              <text className="field-label">文件名</text>
              <view className="choices">{filenames.map(([value, label]) =>
                <Button key={value} label={label} onTap={() => setFilename(value)} selected={filename === value} disabled={isLocked} />
              )}</view>
            </view>
          </view>
          <view className="results panel">
            <view className="result-heading">
              <view className="panel-heading">
                <text className="heading">刮削结果</text>
                {job && <text className="muted">{status?.processed}/{job.total} 首</text>}
              </view>
              {job && <view className="job-line">
                <text className="job-state">
                  {job.state === 'running' && job.checked === job.total
                    ? '写入高把握结果'
                    : labels[job.state] ?? job.state}
                </text>
                {job.state === 'running' && <text className="muted">已识别 {job.checked}/{job.total}</text>}
                <text className="muted">已写入 {status?.counts.written ?? 0}</text>
                <text className="muted">待确认 {status?.counts.review ?? 0}</text>
              </view>}
              {job?.detail && <text className="error-text">{readError(job.detail)}</text>}
              {!!status?.processed && <view className="choices result-filters">
                <Button label="全部结果" onTap={() => { setFilter(''); setPage(0) }} selected={filter === ''} />
                <Button label="待确认" onTap={() => { setFilter('review'); setPage(0) }} selected={filter === 'review'} />
              </view>}
              {width >= 960 && !!status?.results.length && <view className="result-grid table-head">
                <text className="file-column muted">文件名</text>
                <text className="match-column muted">匹配版本</text>
                <text className="state-column muted">状态</text>
              </view>}
            </view>
            <scroll-view className="result-scroll" scroll-y>
              {status?.results.map(result => (
                <view key={result.song_id} className="track">
                  <view
                    className="result-grid result-summary"
                    accessibility-element={true}
                    accessibility-traits="button"
                    accessibility-label={trackName(result.path) + '，' + (labels[result.state] ?? result.state)}
                    bindtap={() => setExpanded(expanded === result.song_id ? null : result.song_id)}
                  >
                    <text className="file-column track-name clip" text-maxline="1">{trackName(result.state === 'written' ? result.target || result.path : result.path)}</text>
                    {width >= 960 && <text className="match-column muted clip" text-maxline="1">
                      {result.match ? (result.match.version || result.match.title) : (result.candidates?.length ? `${result.candidates.length} 个候选` : '—')}
                    </text>}
                    <text className={`state-column state state-${result.state}`}>{labels[result.state] ?? result.state}</text>
                  </view>
                  {(expanded === result.song_id || filter === 'review') && <view className="track-detail">
                    <text className="path-detail">{result.path}</text>
                    {result.target && result.target !== result.path && <text className="path-detail">→ {result.target}</text>}
                    {result.detail && <text className="muted">{readError(result.detail)}</text>}
                    {result.warning && <text className="muted">{readError(result.warning)}</text>}
                    {result.match && <CandidateView match={result.match} />}
                    {result.state === 'review' && result.candidates?.map(candidate => (
                      <view key={candidate.id} className="candidate">
                        <CandidateView match={candidate} />
                        <Button label="写入此版本" disabled={isLocked} onTap={() => {
                          if (job) void action('/api/job/confirm', { job_id: job.id, song_id: result.song_id, candidate_id: candidate.id })
                        }} />
                      </view>
                    ))}
                  </view>}
                </view>
              ))}
              {!status?.results.length && <text className="empty">
                {job ? isActive ? '等待处理结果' : '当前没有结果' : '勾选目录并开始刮削后，结果会显示在这里。'}
              </text>}
              {resultCount > pageSize && <view className="paging">
                <Button label="上一页" disabled={page === 0} onTap={() => setPage(page - 1)} />
                <text className="muted">{page + 1}/{Math.ceil(resultCount / pageSize)}</text>
                <Button label="下一页" disabled={(page + 1) * pageSize >= resultCount} onTap={() => setPage(page + 1)} />
              </view>}
            </scroll-view>
          </view>
        </view>
      </view>}
      {capabilities?.compatible && <view className="footer">
        {(actionError || pollError) && <text className="error-text">{actionError || pollError}</text>}
        <view className="footer-row">
          <view className="selection">
            <text className="count">已选 {count} 首</text>
            <text className="muted example-path" text-maxline="3">{example ? `示例 ${example}` : '请选择要刮削的目录'}</text>
          </view>
          {isActive && job ? <Button label={job.state === 'cancelling' ? '正在取消' : '取消任务'}
            disabled={busy || job.state === 'cancelling'} onTap={() => { void action('/api/job/cancel', { job_id: job.id }) }} />
            : <Button label="开始刮削" primary disabled={!count || busy} onTap={() => {
              void action('/api/job', { directories: selected, layout, filename }, () => { setPage(0); setFilter(''); setExpanded(null) })
            }} />}
        </view>
      </view>}
    </view>
  )
}

function CandidateView({ match }: { match: Candidate }) {
  return <view className="candidate-info">
    <text className="match-title">{match.title} · {match.artists.join(' & ')}</text>
    <text className="muted">专辑 {match.album || match.albums?.join(' / ') || '未确认'}</text>
    <text className="muted">版本 {match.version || '未注明'} · {durationText(match.duration)} · {match.method === 'fingerprint' ? '指纹' : '文字'}</text>
  </view>
}

function readError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return reasons[message] ?? message
}
