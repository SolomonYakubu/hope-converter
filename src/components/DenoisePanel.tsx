import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useStore } from 'zustand'
import {
  AudioLines, Check, ChevronRight, CircleAlert, Folder, FolderOpen, Headphones, LoaderCircle,
  Plus, RotateCcw, Sliders, Square, Trash2, UploadCloud, WandSparkles
} from 'lucide-react'
import {
  DENOISE_LOUDNESS_TARGET_LUFS,
  DENOISE_MAX_ATTENUATION_DB,
  DENOISE_MAX_SPEECH_GAIN_DB,
  originalShareForLimitDb,
  type DenoiseAudioFormat,
  type DenoiseEngineInfo,
  type DenoiseOptions
} from '../../electron/types/denoise'
import {
  denoiseStore, levelModeFor,
  type DenoiseItem, type DenoiseLevelMode, type DenoiseStatus
} from '../stores/denoise-store'
import { describeAdditions } from '../stores/queue-additions'
import type { HopeConverterApi, InputFile } from '../types/hope-converter'
import { decodeAudio } from '../utils/audio-graph'
import { createInputFileFromDrop, formatBytes } from '../utils/conversion'
import { describeMetadata } from '../utils/media-summary'
import { AbPlayer } from './AbPlayer'
import { KindIcon } from './KindIcon'

/** Long enough to judge the difference, short enough to render in a moment. */
const PREVIEW_SECONDS = 8
const FORMAT_OPTIONS: readonly { value: DenoiseAudioFormat; label: string }[] = [
  { value: 'flac', label: 'FLAC · lossless' }, { value: 'wav', label: 'WAV · lossless' },
  { value: 'mp3', label: 'MP3' }, { value: 'm4a', label: 'M4A' }
]
// The model's own strength dial, in dB of allowed attenuation — which is the same
// number as the share of the original recording kept underneath the result, since
// the limit is a dry/wet mix rather than a threshold. That share is what carries a
// quiet word-ending the model did not hold as speech, so the presets are spaced by
// what they keep: half the original, a quarter, an eighth, a sixteenth.
//
// These four are the whole control in the panel; the dB slider they set lives under
// Advanced, because a number between them has never been the difference between a
// good result and a bad one.
const STRENGTH_PRESETS = [
  { value: 6, label: 'Gentle' }, { value: 12, label: 'Balanced' },
  { value: 18, label: 'Strong' }, { value: DENOISE_MAX_ATTENUATION_DB, label: 'Maximum' }
] as const
/**
 * The level stage as one question with three answers. Both stages are FFmpeg's work
 * rather than the model's, and both can run at once, but "how loud should this end
 * up" is the only form the choice takes for someone who has not met LUFS before.
 */
const LEVEL_OPTIONS: readonly { value: DenoiseLevelMode, label: string, hint: string }[] = [
  { value: 'as-recorded', label: 'As recorded', hint: 'Keep the level the recording came in at' },
  { value: 'lift-speech', label: 'Lift quiet voice', hint: 'Raise quiet speech toward the peaks' },
  { value: 'match-loudness', label: 'Even loudness', hint: `Land every file at ${DENOISE_LOUDNESS_TARGET_LUFS} LUFS` }
]
const STATUS_LABELS: Record<DenoiseStatus, string> = {
  queued: 'Ready', processing: 'Cleaning', completed: 'Cleaned', error: 'Needs attention', cancelled: 'Cancelled'
}
const RETRYABLE: readonly DenoiseStatus[] = ['queued', 'error', 'cancelled']

/** The kept share of the original, as the whole percent the readout quotes. */
function originalSharePercent(attenuationLimitDb: number): number {
  return Math.round(originalShareForLimitDb(attenuationLimitDb) * 100)
}

interface PreviewClips {
  name: string
  /** The settings the clips were rendered with, which the sliders may since have left behind. */
  caption: string
  original: AudioBuffer
  cleaned: AudioBuffer
}

export interface DenoisePanelProps {
  api: HopeConverterApi | undefined
  /** Null until the engine has been asked whether it can run. */
  engine: DenoiseEngineInfo | null
  outputDirectory: string | null
  onChooseOutputDirectory: () => Promise<string | null>
  onNotice: (message: string | null) => void
}

/**
 * The cleanup view: add voice recordings or videos, listen to the difference,
 * then write cleaned copies. The model runs in the main process, so this panel
 * only sends requests and renders what comes back.
 */
export function DenoisePanel({ api, engine, outputDirectory, onChooseOutputDirectory, onNotice }: DenoisePanelProps) {
  const items = useStore(denoiseStore, (state) => state.items)
  const strength = useStore(denoiseStore, (state) => state.strength)
  const postFilter = useStore(denoiseStore, (state) => state.postFilter)
  const speechGainDb = useStore(denoiseStore, (state) => state.speechGainDb)
  const normalizeLoudness = useStore(denoiseStore, (state) => state.normalizeLoudness)
  const audioFormat = useStore(denoiseStore, (state) => state.audioFormat)
  const [isDragging, setIsDragging] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewClips | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const probedIds = useRef(new Set<string>())

  const engineReady = engine?.available === true
  const activeCount = items.filter((item) => item.status === 'processing').length
  const isRunning = isStarting || activeCount > 0
  const candidates = useMemo(() => items.filter((item) => isRetryable(item) && !isSilent(item)), [items])
  const finishedCount = items.filter((item) => item.status !== 'queued' && item.status !== 'processing').length
  // A bare "12" tells a screen reader nothing about what the dial does, and the dB
  // number is the less useful half of it.
  const strengthDescription = strength === 0
    ? 'Off, the audio is written untouched'
    : `${strength} dB, keeping ${originalSharePercent(strength)} percent of the original`
  const levelMode = levelModeFor({ speechGainDb, normalizeLoudness })

  // The same ffprobe pass the conversion queue makes: it fills in the duration
  // chip and reveals a file with no soundtrack before the model is asked for one.
  useEffect(() => {
    if (!api) return
    for (const item of items) {
      if (item.metadata || probedIds.current.has(item.id)) continue
      probedIds.current.add(item.id)
      void api.probeMedia(item.path)
        .then((metadata) => denoiseStore.getState().setMetadata(item.id, metadata))
        .catch(() => undefined)
    }
  }, [api, items])

  function currentOptions(): DenoiseOptions {
    const state = denoiseStore.getState()
    return {
      attenuationLimitDb: state.strength,
      postFilterBeta: state.postFilter ? 0.02 : 0,
      speechGainDb: state.speechGainDb,
      normalizeLoudness: state.normalizeLoudness
    }
  }

  function addFiles(files: InputFile[]) {
    const supported = files.filter((file) => file.path && file.kind !== 'image')
    const outcome = denoiseStore.getState().addFiles(supported)
    onNotice(supported.length === files.length
      ? describeAdditions(outcome)
      : 'Only audio and video files have a soundtrack to clean up.')
  }

  async function browseFiles() {
    if (!api) {
      fileInputRef.current?.click()
      return
    }
    try {
      addFiles(await api.selectFiles())
    } catch (error) {
      onNotice(describe(error, 'Could not open the file picker.'))
    }
  }

  function handleBrowserFiles(fileList: FileList | null) {
    if (!fileList) return
    const converted: InputFile[] = []
    let missingPath = false
    for (const file of Array.from(fileList)) {
      const inputFile = api ? createInputFileFromDrop(file, api.getPathForFile) : null
      if (inputFile) converted.push(inputFile)
      else missingPath = true
    }
    addFiles(converted)
    if (missingPath) onNotice('Only supported files with an Electron local path can be added. Use Browse for the best experience.')
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

  /**
   * Runs a specific set of rows with whatever the settings currently say.
   *
   * Both the batch button and a single row's "clean again" come through here, so a
   * retry after moving the sliders takes exactly the path the batch would have.
   */
  async function runFiles(pending: DenoiseItem[]) {
    if (!api || !pending.length) return
    const directory = outputDirectory ?? await onChooseOutputDirectory()
    if (!directory) return
    onNotice(null)
    setIsStarting(true)

    const options = currentOptions()
    const format = denoiseStore.getState().audioFormat
    // The worker processes one file at a time, so the whole batch can be handed
    // over at once: each row waits at "Ready" until its own turn comes up.
    await Promise.all(pending.map(async (item) => {
      denoiseStore.getState().setStatus(item.id, 'queued')
      try {
        await api.denoise({
          id: item.id,
          inputPath: item.path,
          outputDirectory: directory,
          // A video keeps its own container, so the format only applies to audio.
          ...(item.kind === 'audio' ? { audioFormat: format } : {}),
          options
        })
      } catch (error) {
        // Failures during the run arrive as events; a request that was refused
        // outright is the one case nothing else reports.
        if (denoiseStore.getState().items.find((entry) => entry.id === item.id)?.status === 'queued') {
          denoiseStore.getState().setStatus(item.id, 'error', describe(error, 'Cleaning could not be started.'))
        }
      }
    }))
    setIsStarting(false)
  }

  async function startDenoising() {
    if (isRunning) return
    const pending = denoiseStore.getState().items.filter((item) => isRetryable(item) && !isSilent(item))
    await runFiles(pending)
  }

  /**
   * Cleans one file again, over the copy it wrote before.
   *
   * The point of this button is the settings: hearing the result is what tells you
   * the strength was too high or the voice too quiet, and by then the row has
   * finished. The output name is derived from the input, so the new copy replaces
   * the old one rather than piling up numbered variants.
   */
  async function retryItem(item: DenoiseItem) {
    if (isRunning) return
    await runFiles([item])
  }

  async function cancelItem(item: DenoiseItem) {
    if (!api) return
    try {
      const stopped = await api.cancelDenoise(item.id)
      // A file the worker never received is only queued here, so it is dropped locally.
      if (stopped || item.status === 'queued') denoiseStore.getState().setStatus(item.id, 'cancelled')
    } catch (error) {
      onNotice(describe(error, 'Could not stop this cleanup.'))
    }
  }

  async function revealItem(item: DenoiseItem) {
    if (!api || !item.outputPath) return
    try {
      await api.showItemInFolder(item.outputPath)
    } catch (error) {
      onNotice(describe(error, 'Could not reveal the cleaned file.'))
    }
  }

  /**
   * Renders the same short window twice and decodes both clips for the A/B player.
   * Only one preview is in flight at a time, which keeps the id stable and the
   * model free for the queue.
   *
   * The WAVs are decoded rather than handed to `<audio>` as blob URLs because the
   * player needs the samples themselves — for the waveform, for level matching,
   * and to keep both versions on one playhead.
   */
  async function previewItem(item: DenoiseItem) {
    if (!api || previewingId) return
    setPreviewingId(item.id)
    onNotice(null)
    try {
      const options = currentOptions()
      const clips = await api.previewDenoise({
        id: `preview-${item.id}`,
        inputPath: item.path,
        startSeconds: 0,
        durationSeconds: PREVIEW_SECONDS,
        options
      })
      // Decoding detaches the buffers, so nothing here is reused afterwards.
      const [original, cleaned] = await Promise.all([decodeAudio(clips.original), decodeAudio(clips.denoised)])
      setPreview({ name: item.name, caption: describeSettings(options), original, cleaned })
    } catch (error) {
      onNotice(describe(error, 'Could not render a preview for this file.'))
    } finally {
      setPreviewingId(null)
    }
  }

  return (
    <div className="content-grid">
      <div className="denoise-column">
        <section className="queue-panel" aria-labelledby="denoise-title">
          <div className="panel-heading">
            <span className="panel-chip"><AudioLines size={19} /></span>
            <div>
              <h2 id="denoise-title">Cleanup queue</h2>
              <span>{items.length
                ? `${items.length} file${items.length === 1 ? '' : 's'} · ${candidates.length} ready`
                : 'Voice recordings and video soundtracks'}</span>
            </div>
            <div className="heading-actions">
              {finishedCount > 0 && (
                <button className="text-button" type="button" onClick={() => denoiseStore.getState().clearFinished()}>
                  <Trash2 size={14} /> Clear finished
                </button>
              )}
            </div>
          </div>

          <div className={`dropzone ${items.length ? 'compact' : 'empty'} ${isDragging ? 'dragging' : ''}`} role="button" tabIndex={0}
            onClick={() => void browseFiles()} onKeyDown={handleDropzoneKey}
            onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}
            onDragOver={(event) => event.preventDefault()} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}>
            <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="video/*,audio/*"
              onChange={(event) => { handleBrowserFiles(event.target.files); event.currentTarget.value = '' }} />
            <span className="upload-icon"><UploadCloud size={20} /></span>
            <div>
              <strong>{isDragging ? 'Drop files to add them' : items.length ? 'Drop more files here' : 'Drop audio or video here'}</strong>
              <span>Speech recordings clean up best · multiple files welcome</span>
            </div>
            <span className="browse-button"><Plus size={16} /> Browse</span>
          </div>

          {items.length > 0 && (
            <div className="file-list">
              {items.map((item) => (
                <DenoiseRow key={item.id} item={item} batchRunning={isRunning} canPreview={engineReady}
                  previewing={previewingId === item.id} previewBusy={previewingId !== null}
                  canRetry={engineReady} onCancel={cancelItem} onPreview={previewItem}
                  onRetry={retryItem} onReveal={revealItem} />
              ))}
            </div>
          )}
        </section>

        {preview && (
          <AbPlayer original={preview.original} cleaned={preview.cleaned}
            name={preview.name} caption={preview.caption} onClose={() => setPreview(null)} />
        )}
      </div>

      <aside className="settings-panel" aria-labelledby="cleanup-settings-title">
        <div className="panel-heading">
          <span className="panel-chip"><Sliders size={19} /></span>
          <div><h2 id="cleanup-settings-title">Cleanup settings</h2><span>Applied to your queue</span></div>
        </div>

        <div className="settings-body">
          {engine && !engine.available && (
            <div className="notice" role="status">
              <CircleAlert size={17} />
              <span>{engine.reason ?? 'Noise removal is unavailable in this build.'}</span>
            </div>
          )}

          <div className="setting-group">
            <div className="strength-row">
              <span className="field-inline" id="denoise-strength-label">Noise reduction</span>
              <span className="field-value">{strength === 0 ? 'Off' : `${strength} dB`}</span>
            </div>
            <div className="preset-group" role="group" aria-labelledby="denoise-strength-label">
              {STRENGTH_PRESETS.map((preset) => (
                <button key={preset.value} type="button" disabled={isRunning}
                  aria-pressed={strength === preset.value}
                  className={`quality-option ${strength === preset.value ? 'selected' : ''}`}
                  onClick={() => denoiseStore.getState().setStrength(preset.value)}>
                  <span>{preset.label}</span>
                </button>
              ))}
            </div>
            <p className="setting-note">
              {strength === 0
                ? 'Off: the soundtrack is written exactly as it arrived. '
                : `Keeps ${originalSharePercent(strength)}% of the original underneath, which is what protects a breath or a trailing consonant. `}
              Built for speech — preview one file before running a batch of music.
            </p>
          </div>

          <div className="setting-group">
            <span className="field-label" id="denoise-level-label">Output level</span>
            <div className="choice-group" role="group" aria-labelledby="denoise-level-label">
              {LEVEL_OPTIONS.map((option) => (
                <button key={option.value} type="button" disabled={isRunning}
                  aria-pressed={levelMode === option.value}
                  className={`choice-option ${levelMode === option.value ? 'selected' : ''}`}
                  onClick={() => denoiseStore.getState().setLevelMode(option.value)}>
                  <span><strong>{option.label}</strong><small>{option.hint}</small></span>
                  {levelMode === option.value && <Check size={15} aria-hidden="true" />}
                </button>
              ))}
            </div>
            <p className="setting-note">{describeLevel(levelMode, speechGainDb)}</p>
          </div>

          <div className="setting-group">
            <span className="field-label">Output</span>
            <label className="select-row">
              <KindIcon kind="audio" />
              <span>Audio files</span>
              <select value={audioFormat} disabled={isRunning}
                onChange={(event) => denoiseStore.getState().setAudioFormat(event.target.value as DenoiseAudioFormat)}
                aria-label="Cleaned audio format">
                {FORMAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <p className="setting-note">A video keeps its own container and its picture is copied untouched — only the soundtrack is re-encoded.</p>
          </div>

          <div className="setting-group">
            <span className="field-label">Save to</span>
            <button className="folder-picker" type="button" onClick={() => void onChooseOutputDirectory()}>
              <Folder size={18} /><span>{outputDirectory ?? 'Choose output folder'}</span><ChevronRight size={17} />
            </button>
          </div>

          {/* The dB dials themselves, folded away: the presets above set them, and
              nothing here is needed to get a good result out of an ordinary file. */}
          <details className="advanced-settings">
            <summary>Fine controls</summary>

            <div className="setting-group">
              <div className="strength-row">
                <label htmlFor="denoise-strength">Reduction, in dB</label>
                <output htmlFor="denoise-strength">{strength === 0 ? 'Off' : `${strength} dB`}</output>
              </div>
              <input id="denoise-strength" className="strength-slider" type="range"
                min={0} max={DENOISE_MAX_ATTENUATION_DB} step={1}
                value={strength} disabled={isRunning} aria-valuetext={strengthDescription}
                onChange={(event) => denoiseStore.getState().setStrength(Number(event.target.value))} />
              <div className="strength-scale">
                <span>Untouched</span><span>{DENOISE_MAX_ATTENUATION_DB} dB</span>
              </div>
            </div>

            <div className="setting-group">
              <div className="strength-row">
                <label htmlFor="denoise-speech-gain">Speech lift</label>
                <output htmlFor="denoise-speech-gain">{speechGainDb === 0 ? 'Off' : `+${speechGainDb} dB`}</output>
              </div>
              <input id="denoise-speech-gain" className="strength-slider" type="range"
                min={0} max={DENOISE_MAX_SPEECH_GAIN_DB} step={1}
                value={speechGainDb} disabled={isRunning}
                onChange={(event) => denoiseStore.getState().setSpeechGainDb(Number(event.target.value))} />
              <div className="strength-scale"><span>As recorded</span><span>+{DENOISE_MAX_SPEECH_GAIN_DB} dB</span></div>
            </div>

            <div className="setting-group">
              <label className={`performance-option ${postFilter ? 'enabled' : ''}`}>
                <span className="performance-icon"><AudioLines size={18} /></span>
                <span><strong>Post-filter</strong><small>Cleaner separation, slightly rougher</small></span>
                <input type="checkbox" checked={postFilter} disabled={isRunning}
                  onChange={(event) => denoiseStore.getState().setPostFilter(event.target.checked)}
                  aria-label="Enable the post-filter" />
                <span className="toggle" aria-hidden="true" />
              </label>
            </div>
          </details>
        </div>

        <div className="conversion-action">
          <button className="convert-button" type="button" disabled={!candidates.length || isRunning || !engineReady}
            onClick={() => void startDenoising()}>
            {isRunning ? <LoaderCircle className="spin" size={19} /> : <WandSparkles size={19} />}
            {activeCount > 0
              ? `Cleaning ${activeCount}…`
              : isStarting ? 'Starting…' : `Clean ${candidates.length || ''} file${candidates.length === 1 ? '' : 's'}`}
          </button>
          <p>{engine === null
            ? 'Checking the noise model…'
            : engineReady
              ? 'Cleaned copies are saved with “-denoised” added to the name.'
              : 'Noise removal is unavailable, so the queue cannot run.'}</p>
        </div>
      </aside>
    </div>
  )
}

function DenoiseRow({
  item, batchRunning, canPreview, previewing, previewBusy, canRetry, onCancel, onPreview, onRetry, onReveal
}: {
  item: DenoiseItem
  /** True while the batch is in flight, when a queued file can still be stopped. */
  batchRunning: boolean
  canPreview: boolean
  previewing: boolean
  previewBusy: boolean
  /** False when the model cannot run, which is the one case a retry could not help. */
  canRetry: boolean
  onCancel: (item: DenoiseItem) => Promise<void>
  onPreview: (item: DenoiseItem) => Promise<void>
  onRetry: (item: DenoiseItem) => Promise<void>
  onReveal: (item: DenoiseItem) => Promise<void>
}) {
  const isActive = item.status === 'processing'
  const silent = isSilent(item)
  const details = item.metadata ? describeMetadata(item.kind, item.metadata) : []
  // Cleaning reuses the queue's converting styles: same meaning, same treatment.
  const statusClass = isActive ? 'converting' : item.status
  const canStop = isActive || (batchRunning && item.status === 'queued')
  // Offered on anything that has already run, including a file that came out badly
  // rather than wrongly: the settings, not the file, are usually what needs changing.
  const showRetry = canRetry && !silent && !batchRunning &&
    (item.status === 'completed' || item.status === 'error' || item.status === 'cancelled')

  return <article className={`queue-row status-${statusClass}`}>
    <div className={`file-kind kind-${item.kind}`}><KindIcon kind={item.kind} /></div>
    <div className="file-info">
      <div className="file-title">
        <strong title={item.name}>{item.name}</strong>
        <span className={`status-pill ${statusClass}`}>
          {item.status === 'completed' && <Check size={12} />}
          {item.status === 'error' && <CircleAlert size={12} />}
          {isActive && <LoaderCircle className="spin" size={12} />}
          {STATUS_LABELS[item.status]}
        </span>
      </div>
      <div className="file-meta">
        <span>{formatBytes(item.size)}</span>
        {details.map((detail) => <span key={detail}><i /> {detail}</span>)}
        {isActive && <><i /><span>{Math.round(item.progress)}%</span></>}
        {isActive && item.speed !== null && <><i /><span>{item.speed.toFixed(1)}× realtime</span></>}
      </div>
      {(isActive || item.status === 'completed') && (
        <div className="progress-track" role="progressbar" aria-label={`${item.name} cleanup progress`}
          aria-valuenow={Math.round(item.progress)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${item.progress}%` }} />
        </div>
      )}
      {silent && <p className="file-error">This file has no audio track to clean up.</p>}
      {item.error && <p className="file-error">{item.error}</p>}
    </div>
    <div className="row-actions">
      {showRetry && (
        <button type="button" onClick={() => void onRetry(item)}
          aria-label={`Clean ${item.name} again with the current settings`}
          title="Clean again with the current settings — replaces the copy already written">
          <RotateCcw size={16} />
        </button>
      )}
      {item.status === 'completed' && (
        <button type="button" onClick={() => void onReveal(item)} aria-label={`Show ${item.name} in folder`} title="Show in folder">
          <FolderOpen size={17} />
        </button>
      )}
      {canPreview && !isActive && !silent && (
        <button type="button" disabled={previewBusy} onClick={() => void onPreview(item)}
          aria-label={`Preview ${item.name} before and after`} title="Hear before and after">
          {previewing ? <LoaderCircle className="spin" size={15} /> : <Headphones size={16} />}
        </button>
      )}
      {canStop
        ? <button type="button" onClick={() => void onCancel(item)} aria-label={`Stop cleaning ${item.name}`} title="Stop"><Square size={15} /></button>
        : <button type="button" onClick={() => denoiseStore.getState().removeItem(item.id)} aria-label={`Remove ${item.name}`} title="Remove from queue"><Trash2 size={17} /></button>}
    </div>
  </article>
}

function isRetryable(item: DenoiseItem): boolean {
  return RETRYABLE.includes(item.status)
}

/** True once a probe has confirmed the file carries no audio the model could work on. */
function isSilent(item: DenoiseItem): boolean {
  return item.metadata !== undefined && !item.metadata.audioCodec
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/**
 * The line under the level control. It quotes the lift's actual dB rather than the
 * preset's, because the fine slider can have moved it, and it says plainly which
 * stage wins when both are on.
 */
function describeLevel(mode: DenoiseLevelMode, speechGainDb: number): string {
  if (mode === 'as-recorded') {
    return 'No level change at all: the file is written exactly as the model produced it.'
  }
  if (mode === 'lift-speech') {
    return `Quiet speech is raised by up to ${speechGainDb} dB toward the peaks, without pushing them into clipping.`
  }
  return `Every file lands at ${DENOISE_LOUDNESS_TARGET_LUFS} LUFS, so recordings from different sessions sound equally loud next to each other.`
    + (speechGainDb > 0 ? ` The ${speechGainDb} dB lift still shapes what reaches the target.` : '')
}

/**
 * The one-line caption above a preview. It names the settings the clips were
 * rendered with, because the sliders can move afterwards and a stale preview
 * that looks current is worse than no preview at all.
 */
function describeSettings(options: DenoiseOptions): string {
  const parts = [`First ${PREVIEW_SECONDS} seconds`]
  parts.push(options.attenuationLimitDb === 0 ? 'noise reduction off' : `${options.attenuationLimitDb} dB reduction`)
  if (options.speechGainDb > 0) parts.push(`+${options.speechGainDb} dB speech`)
  if (options.normalizeLoudness) parts.push(`${DENOISE_LOUDNESS_TARGET_LUFS} LUFS`)
  return parts.join(' · ')
}
