import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { useStore } from 'zustand'
import {
  Check, ChevronRight, CircleAlert, FileAudio, FileCheck2, FileImage, FileVideo, Folder,
  FolderOpen, Gauge, Info, Layers, LoaderCircle, ListVideo, Moon, Pause, Play, Plus,
  ShieldCheck, Sliders, Sparkles, Square, Sun, Trash2, UploadCloud, X, Zap
} from 'lucide-react'
import type { HardwareCapabilities, MediaKind } from '../electron/types/conversion'
import logoUrl from './assets/logo.png'
import { conversionStore, type Concurrency, type QueueItem, type QueueStatus } from './stores/conversion-store'
import type { HopeConverterApi, InputFile } from './types/hope-converter'
import { PausableGate, runWithConcurrency } from './utils/concurrency'
import { createConversionOptions, createInputFileFromDrop, createOutputPath, FORMAT_OPTIONS, formatBytes } from './utils/conversion'
import { describeMetadata } from './utils/media-summary'

type Theme = 'light' | 'dark'
// `label` is the short header badge; `version` keeps FFmpeg's own banner for the
// About dialog, which is where the project credit belongs.
type FfmpegState = { state: 'checking' | 'ready' | 'unavailable'; label: string; version: string | null }

const KIND_LABELS: Record<MediaKind, string> = { video: 'Video', audio: 'Audio', image: 'Image' }
const QUALITY_OPTIONS = [
  { value: 'high', label: 'High quality', short: 'High', detail: 'Larger file' },
  { value: 'balanced', label: 'Balanced', short: 'Balanced', detail: 'Recommended' },
  { value: 'small', label: 'Smaller file', short: 'Smaller', detail: 'Faster export' }
] as const
const CONCURRENCY_OPTIONS: readonly Concurrency[] = [1, 2, 3, 4]

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('hope-converter-theme')
  if (stored === 'light' || stored === 'dark') return stored
  // The brand palette is designed dark-first, so that is the default until the
  // person picks otherwise.
  return 'dark'
}

function App() {
  const items = useStore(conversionStore, (state) => state.items)
  const outputDirectory = useStore(conversionStore, (state) => state.outputDirectory)
  const quality = useStore(conversionStore, (state) => state.quality)
  const performanceMode = useStore(conversionStore, (state) => state.performanceMode)
  const concurrency = useStore(conversionStore, (state) => state.concurrency)
  const queuePaused = useStore(conversionStore, (state) => state.queuePaused)
  const formats = useStore(conversionStore, (state) => state.formats)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [isDragging, setIsDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [ffmpeg, setFfmpeg] = useState<FfmpegState>({ state: 'checking', label: 'Checking…', version: null })
  const [hardware, setHardware] = useState<HardwareCapabilities | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const probedIds = useRef(new Set<string>())
  const queueGate = useMemo(() => new PausableGate(), [])

  const api = typeof window !== 'undefined'
    ? window.hopeConverter as HopeConverterApi | undefined
    : undefined
  const activeCount = items.filter((item) => item.status === 'converting').length
  const pausedCount = items.filter((item) => item.status === 'paused').length
  const completedCount = items.filter((item) => item.status === 'completed').length
  const readyCount = items.filter((item) => ['queued', 'error', 'cancelled'].includes(item.status)).length
  const finishedCount = items.filter((item) => ['completed', 'error', 'cancelled'].includes(item.status)).length
  const queuedBytes = items.reduce((total, item) => total + item.size, 0)
  const isRunning = activeCount + pausedCount > 0 || isStarting
  const mediaKinds = useMemo(() => [...new Set(items.map((item) => item.kind))], [items])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('hope-converter-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!api) {
      setFfmpeg({ state: 'unavailable', label: 'Desktop bridge offline', version: null })
      return
    }

    void api.getFFmpegVersion()
      .then((version) => setFfmpeg({ state: 'ready', label: 'Engine ready', version }))
      .catch(() => setFfmpeg({ state: 'unavailable', label: 'FFmpeg unavailable', version: null }))
    void api.detectHardware().then(setHardware).catch(() => setHardware(null))

    const unsubscribeProgress = api.onProgress((progress) => conversionStore.getState().updateProgress(progress))
    const unsubscribeComplete = api.onComplete(({ id, outputPath }) => conversionStore.getState().completeItem(id, outputPath))
    const unsubscribeCancelled = api.onCancelled(({ id }) => conversionStore.getState().setStatus(id, 'cancelled'))
    const unsubscribeError = api.onError(({ id, message }) => conversionStore.getState().setStatus(id, 'error', message))
    return () => {
      unsubscribeProgress()
      unsubscribeComplete()
      unsubscribeCancelled()
      unsubscribeError()
    }
  }, [api])

  // Inspect new files with ffprobe so the queue can show real media details.
  useEffect(() => {
    if (!api) return
    for (const item of items) {
      if (item.metadata || probedIds.current.has(item.id)) continue
      probedIds.current.add(item.id)
      void api.probeMedia(item.path)
        .then((metadata) => conversionStore.getState().setMetadata(item.id, metadata))
        .catch(() => undefined)
    }
  }, [api, items])

  function addFiles(files: InputFile[]) {
    const supported = files.filter((file) => file.path && file.kind)
    conversionStore.getState().addFiles(supported)
    if (supported.length !== files.length) setNotice('Some files could not be added because they were unsupported or had no local path.')
    else setNotice(null)
  }

  async function browseFiles() {
    if (api) {
      try {
        addFiles(await api.selectFiles())
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not open the file picker.')
      }
      return
    }
    fileInputRef.current?.click()
  }

  function handleBrowserFiles(fileList: FileList | null) {
    if (!fileList) return
    const converted: InputFile[] = []
    let missingPath = false
    for (const file of Array.from(fileList)) {
      const inputFile = api
        ? createInputFileFromDrop(file, api.getPathForFile)
        : null
      if (inputFile) converted.push(inputFile)
      else missingPath = true
    }
    addFiles(converted)
    if (missingPath) setNotice('Only supported files with an Electron local path can be added. Use Browse files for the best experience.')
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragging(false)
    handleBrowserFiles(event.dataTransfer.files)
  }

  function handleDropzoneKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      void browseFiles()
    }
  }

  async function chooseOutputDirectory(): Promise<string | null> {
    if (!api) {
      setNotice('Output folder selection is only available in the desktop app.')
      return null
    }
    try {
      const selected = await api.selectOutputDirectory()
      if (selected) conversionStore.getState().setOutputDirectory(selected)
      return selected
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not select an output folder.')
      return null
    }
  }

  async function startConversions() {
    if (!api || isRunning) return
    let directory = conversionStore.getState().outputDirectory
    if (!directory) directory = await chooseOutputDirectory()
    if (!directory) return

    const state = conversionStore.getState()
    const candidates = state.items.filter((item) => ['queued', 'error', 'cancelled'].includes(item.status))
    if (!candidates.length) return
    setIsStarting(true)
    setNotice(null)
    queueGate.resume()
    state.setQueuePaused(false)

    const outputDirectory = directory
    await runWithConcurrency(candidates, state.concurrency, async (item) => {
      const latest = conversionStore.getState()
      const current = latest.items.find((entry) => entry.id === item.id) ?? item
      const extension = latest.formats[item.kind]
      const outputPath = createOutputPath(item, outputDirectory, extension)
      latest.setStatus(item.id, 'converting')
      try {
        await api.convert({
          id: item.id,
          inputPath: item.path,
          outputPath,
          // A probed duration keeps progress accurate without a second ffprobe run.
          ...(item.kind === 'image' ? {} : { durationSeconds: current.metadata?.duration }),
          options: createConversionOptions(
            item.kind,
            latest.formats,
            latest.quality,
            hardware?.preferredEncoder,
            latest.performanceMode
          )
        })
      } catch (error) {
        latest.setStatus(item.id, 'error', error instanceof Error ? error.message : 'Conversion could not be started.')
      }
    }, queueGate)
    setIsStarting(false)
  }

  async function toggleQueuePause() {
    if (!api) return
    const state = conversionStore.getState()
    if (state.queuePaused) {
      queueGate.resume()
      state.setQueuePaused(false)
      await Promise.all(state.items
        .filter((item) => item.status === 'paused')
        .map(async (item) => {
          if (await api.resume(item.id).catch(() => false)) {
            conversionStore.getState().setStatus(item.id, 'converting')
          }
        }))
      return
    }

    queueGate.pause()
    state.setQueuePaused(true)
    const active = state.items.filter((item) => item.status === 'converting')
    const suspended = await Promise.all(active.map(async (item) => {
      const paused = await api.pause(item.id).catch(() => false)
      if (paused) conversionStore.getState().setStatus(item.id, 'paused')
      return paused
    }))
    if (suspended.some((paused) => !paused)) {
      setNotice('This platform cannot suspend a running FFmpeg process, so files already converting will finish. Remaining files stay queued until you resume.')
    }
  }

  async function togglePauseItem(item: QueueItem) {
    if (!api) return
    try {
      if (item.status === 'paused') {
        if (await api.resume(item.id)) conversionStore.getState().setStatus(item.id, 'converting')
        return
      }
      if (await api.pause(item.id)) conversionStore.getState().setStatus(item.id, 'paused')
      else setNotice('This platform cannot suspend a running FFmpeg process. Cancel the file instead, or pause the queue to hold the remaining files.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not pause this conversion.')
    }
  }

  async function cancelItem(item: QueueItem) {
    if (!api) return
    try {
      const cancelled = await api.cancel(item.id)
      if (cancelled) conversionStore.getState().setStatus(item.id, 'cancelled')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not cancel this conversion.')
    }
  }

  async function revealItem(item: QueueItem) {
    if (!api || !item.outputPath) return
    try {
      await api.showItemInFolder(item.outputPath)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not reveal the converted file.')
    }
  }

  return (
    <div className="app-shell">
      <header className="app-chrome">
        <div className="brand" aria-label="Hope Converter">
          <div className="brand-mark"><img src={logoUrl} alt="" width={42} height={42} /></div>
          <div><strong>Hope Converter</strong><span>Private media tools</span></div>
        </div>
        <div className="chrome-actions">
          {/* Nothing is worth saying about a healthy engine, so the badge only
              appears when FFmpeg is missing and conversion cannot run. */}
          {ffmpeg.state === 'unavailable' && (
            <div className="ffmpeg-status unavailable">
              <span className="status-dot" />
              <span>{ffmpeg.label}</span>
            </div>
          )}
          <button className="icon-button" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button" type="button" onClick={() => setAboutOpen(true)} aria-label="About Hope Converter">
            <Info size={18} />
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="intro">
          <div className="intro-title">
            <span className="title-chip"><Zap size={22} strokeWidth={2.4} /></span>
            <div>
              <p className="eyebrow">Fast · Local · Yours</p>
              <h1>Conversion workspace</h1>
            </div>
          </div>
          <div className="privacy-card"><ShieldCheck size={20} /><div><strong>Your files stay on this device</strong><span>Every conversion runs locally with FFmpeg.</span></div></div>
        </section>

        {notice && <div className="notice" role="status"><CircleAlert size={17} /><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={16} /></button></div>}

        <div className="content-grid">
          <div className="main-column">
            <section className="stat-row" aria-label="Queue overview">
              <article className="stat-card featured">
                <div className="stat-head"><span className="stat-chip"><Layers size={18} /></span><span>In queue</span></div>
                <p className="stat-value">{items.length}<small>{items.length === 1 ? 'file' : 'files'}</small></p>
                <div className="stat-foot"><span>{queuedBytes ? `${formatBytes(queuedBytes)} total` : 'Nothing added yet'}</span><StatBars pattern={[38, 62, 100, 54, 30, 46]} /></div>
              </article>
              <article className="stat-card">
                <div className="stat-head"><span className="stat-chip"><Zap size={18} /></span><span>Converting</span></div>
                <p className="stat-value">{activeCount}<small>active</small></p>
                <div className="stat-foot"><span>{pausedCount ? `${pausedCount} paused` : queuePaused ? 'Queue paused' : `Up to ${concurrency} at once`}</span><StatBars pattern={[26, 48, 34, 100, 62, 40]} /></div>
              </article>
              <article className="stat-card">
                <div className="stat-head"><span className="stat-chip"><FileCheck2 size={18} /></span><span>Completed</span></div>
                <p className="stat-value">{completedCount}<small>done</small></p>
                <div className="stat-foot"><span>{completedCount ? 'Ready to open' : 'No exports yet'}</span><StatBars pattern={[30, 44, 58, 72, 86, 100]} /></div>
              </article>
            </section>

            <section className="queue-panel" aria-labelledby="queue-title">
              <div className="panel-heading">
                <span className="panel-chip"><ListVideo size={19} /></span>
                <div><h2 id="queue-title">Conversion queue</h2><span>{items.length ? `${items.length} file${items.length === 1 ? '' : 's'} · ${readyCount} ready` : 'Ready when you are'}</span></div>
                <div className="heading-actions">
                  {(activeCount + pausedCount > 0 || (queuePaused && readyCount > 0)) && (
                    <button className="text-button" type="button" onClick={() => void toggleQueuePause()}>
                      {queuePaused ? <><Play size={14} /> Resume</> : <><Pause size={14} /> Pause</>}
                    </button>
                  )}
                  {finishedCount > 0 && <button className="text-button" type="button" onClick={() => conversionStore.getState().clearFinished()}><Trash2 size={14} /> Clear finished</button>}
                </div>
              </div>

              {/* The dropzone is the only place files get added: it fills the panel
                  while the queue is empty, then shrinks to a strip above the list. */}
              <div className={`dropzone ${items.length ? 'compact' : 'empty'} ${isDragging ? 'dragging' : ''}`} role="button" tabIndex={0}
                onClick={() => void browseFiles()} onKeyDown={handleDropzoneKey}
                onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}
                onDragOver={(event) => event.preventDefault()} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}>
                <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="video/*,audio/*,image/*" onChange={(event) => { handleBrowserFiles(event.target.files); event.currentTarget.value = '' }} />
                {items.length === 0
                  ? <span className="drop-art"><img src={logoUrl} alt="" width={76} height={76} /></span>
                  : <span className="upload-icon"><UploadCloud size={20} /></span>}
                <div>
                  <strong>{isDragging ? 'Drop files to add them' : items.length ? 'Drop more files here' : 'Drop your media here'}</strong>
                  <span>Video, audio, or images · multiple files welcome</span>
                </div>
                <span className="browse-button"><Plus size={16} /> Browse</span>
              </div>

              {items.length > 0 && (
                <div className="file-list">
                  {items.map((item) => (
                    <QueueRow key={item.id} item={item} onCancel={cancelItem} onReveal={revealItem} onTogglePause={togglePauseItem} />
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="settings-panel" aria-labelledby="settings-title">
            <div className="panel-heading">
              <span className="panel-chip"><Sliders size={19} /></span>
              <div><h2 id="settings-title">Conversion settings</h2><span>Applied to your queue</span></div>
            </div>

            {/* Only this middle band scrolls, so the convert button never leaves the
                viewport on a short window. */}
            <div className="settings-body">
              <div className="setting-group">
                <label className="field-label">Output format</label>
                {mediaKinds.length === 0 ? <div className="empty-setting">Add files to see compatible formats</div> : mediaKinds.map((kind) => (
                  <label className="select-row" key={kind}>
                    <KindIcon kind={kind} />
                    <span>{KIND_LABELS[kind]}</span>
                    <select value={formats[kind]} onChange={(event) => conversionStore.getState().setFormat(kind, event.target.value)} aria-label={`${KIND_LABELS[kind]} output format`}>
                      {FORMAT_OPTIONS[kind].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                ))}
              </div>

              <fieldset className="setting-group quality-group">
                <legend>Quality</legend>
                {QUALITY_OPTIONS.map((option) => (
                  <label className={`quality-option ${quality === option.value ? 'selected' : ''}`} key={option.value} title={`${option.label} · ${option.detail}`}>
                    <input type="radio" name="quality" value={option.value} checked={quality === option.value} onChange={() => conversionStore.getState().setQuality(option.value)} aria-label={`${option.label} · ${option.detail}`} />
                    <span>{option.short}</span>
                  </label>
                ))}
              </fieldset>

              <div className="setting-group">
                <label className={`performance-option ${performanceMode ? 'enabled' : ''}`}>
                  <span className="performance-icon"><Gauge size={18} /></span>
                  <span>
                    <strong>Hardware acceleration</strong>
                    <small>{hardware?.preferredEncoder
                      ? `Available · ${hardware.preferredEncoder.replaceAll('_', ' ')}`
                      : 'No hardware encoder detected · software encoding'}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={performanceMode}
                    onChange={(event) => conversionStore.getState().setPerformanceMode(event.target.checked)}
                    aria-label="Prefer hardware acceleration"
                  />
                  <span className="toggle" aria-hidden="true" />
                </label>
                <label className="select-row" htmlFor="concurrency">
                  <Layers size={18} />
                  <span>At once</span>
                  <select
                    id="concurrency"
                    value={concurrency}
                    disabled={isRunning}
                    onChange={(event) => conversionStore.getState().setConcurrency(Number(event.target.value) as Concurrency)}
                    aria-label="Simultaneous conversions"
                  >
                    {CONCURRENCY_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option === 1 ? '1 file' : `${option} files`}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="setting-group">
                <label className="field-label" htmlFor="output-folder">Save to</label>
                <button id="output-folder" className="folder-picker" type="button" onClick={() => void chooseOutputDirectory()}>
                  <Folder size={18} /><span>{outputDirectory ?? 'Choose output folder'}</span><ChevronRight size={17} />
                </button>
              </div>
            </div>

            <div className="conversion-action">
              <button className="convert-button" type="button" disabled={!readyCount || isRunning || ffmpeg.state === 'unavailable'} onClick={() => void startConversions()}>
                {isRunning ? <LoaderCircle className="spin" size={19} /> : <Sparkles size={19} />}
                {queuePaused && pausedCount > 0
                  ? `Paused ${pausedCount} file${pausedCount === 1 ? '' : 's'}`
                  : activeCount > 0
                    ? `Converting ${activeCount}…`
                    : isStarting ? 'Starting…' : `Convert ${readyCount || ''} file${readyCount === 1 ? '' : 's'}`}
              </button>
              <p>{outputDirectory ? 'Converted files keep their original names.' : 'Choose a destination before conversion begins.'}</p>
            </div>
          </aside>
        </div>
      </main>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} ffmpegVersion={ffmpeg.version} />
    </div>
  )
}

// Keeps the FFmpeg credit and the story behind the name out of the workspace.
function AboutDialog({ open, onClose, ffmpegVersion }: {
  open: boolean
  onClose: () => void
  ffmpegVersion: string | null
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Clicks land on the dialog element itself only when they hit the backdrop.
  function handleClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) onClose()
  }

  return (
    <dialog className="about-dialog" ref={dialogRef} onClose={onClose} onClick={handleClick} aria-labelledby="about-title">
      <div className="dialog-inner">
        <button className="dialog-close" type="button" onClick={onClose} aria-label="Close about"><X size={16} /></button>

        <div className="about-head">
          <span className="about-mark"><img src={logoUrl} alt="" width={54} height={54} /></span>
          <h2 id="about-title">Hope Converter</h2>
          <p>Private, local media conversion</p>
        </div>

        <p className="about-story">
          Named after Hope. She kept needing to convert videos and kept ending up on
          online tools — uploads, waiting, and her files sitting on someone else&apos;s
          server. This app is that job done properly, on your own machine.
        </p>

        <dl className="about-facts">
          <div><dt>Privacy</dt><dd>Files are read and written on this device. Nothing is uploaded.</dd></div>
          <div><dt>Engine</dt><dd>{ffmpegVersion ?? 'FFmpeg was not detected on this system.'}</dd></div>
        </dl>
      </div>
    </dialog>
  )
}

function KindIcon({ kind }: { kind: MediaKind }) {
  if (kind === 'video') return <FileVideo size={18} />
  if (kind === 'audio') return <FileAudio size={18} />
  return <FileImage size={18} />
}

// Decorative bar cluster that gives each summary card the dashboard's rhythm.
function StatBars({ pattern }: { pattern: readonly number[] }) {
  const peak = Math.max(...pattern)
  return (
    <span className="stat-bars" aria-hidden="true">
      {pattern.map((height, index) => (
        <i key={index} className={height === peak ? 'peak' : undefined} style={{ height: `${height}%` }} />
      ))}
    </span>
  )
}

const STATUS_LABELS: Record<QueueStatus, string> = { queued: 'Ready', converting: 'Converting', paused: 'Paused', completed: 'Complete', error: 'Needs attention', cancelled: 'Cancelled' }

function QueueRow({ item, onCancel, onReveal, onTogglePause }: {
  item: QueueItem
  onCancel: (item: QueueItem) => Promise<void>
  onReveal: (item: QueueItem) => Promise<void>
  onTogglePause: (item: QueueItem) => Promise<void>
}) {
  const isActive = item.status === 'converting' || item.status === 'paused'
  const details = item.metadata ? describeMetadata(item.kind, item.metadata) : []

  return <article className={`queue-row status-${item.status}`}>
    <div className={`file-kind kind-${item.kind}`}><KindIcon kind={item.kind} /></div>
    <div className="file-info">
      <div className="file-title"><strong title={item.name}>{item.name}</strong><span className={`status-pill ${item.status}`}>{item.status === 'completed' && <Check size={12} />}{item.status === 'error' && <CircleAlert size={12} />}{item.status === 'converting' && <LoaderCircle className="spin" size={12} />}{item.status === 'paused' && <Pause size={12} />}{STATUS_LABELS[item.status]}</span></div>
      <div className="file-meta">
        <span>{formatBytes(item.size)}</span><i /> <span>{KIND_LABELS[item.kind]}</span>
        {details.map((detail) => <span key={detail}><i /> {detail}</span>)}
        {isActive && <><i /><span>{Math.round(item.progress)}%</span></>}
      </div>
      {(isActive || item.status === 'completed') && <div className="progress-track" role="progressbar" aria-label={`${item.name} conversion progress`} aria-valuenow={item.progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${item.progress}%` }} /></div>}
      {item.error && <p className="file-error">{item.error}</p>}
    </div>
    <div className="row-actions">
      {item.status === 'completed' && <button type="button" onClick={() => void onReveal(item)} aria-label={`Show ${item.name} in folder`} title="Show in folder"><FolderOpen size={17} /></button>}
      {isActive && <button type="button" onClick={() => void onTogglePause(item)} aria-label={`${item.status === 'paused' ? 'Resume' : 'Pause'} ${item.name}`} title={item.status === 'paused' ? 'Resume conversion' : 'Pause conversion'}>{item.status === 'paused' ? <Play size={15} /> : <Pause size={15} />}</button>}
      {isActive ? <button type="button" onClick={() => void onCancel(item)} aria-label={`Cancel ${item.name}`} title="Cancel conversion"><Square size={15} /></button> : <button type="button" onClick={() => conversionStore.getState().removeItem(item.id)} aria-label={`Remove ${item.name}`} title="Remove from queue"><Trash2 size={17} /></button>}
    </div>
  </article>
}

export default App
