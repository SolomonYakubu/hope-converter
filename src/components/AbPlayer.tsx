import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AudioLines, Pause, Play, Repeat, Scale, Volume2, X } from 'lucide-react'
import { createAbGraph, getAudioContext, type AbGraphHandle } from '../utils/audio-graph'
import { computePeaks, formatClock, levelMatchGain, peaksToPath } from '../utils/waveform'

/** Columns in the drawn envelope. Stretched by the viewBox, so this is detail, not width. */
const WAVEFORM_COLUMNS = 480
const WAVEFORM_HEIGHT = 100
/** Long enough not to click, short enough to feel like the same instant. */
const CROSSFADE_SECONDS = 0.04

export type AbSide = 'original' | 'cleaned'

export interface AbPlayerProps {
  original: AudioBuffer
  cleaned: AudioBuffer
  /** File the clips came from, shown in the header. */
  name: string
  /** The settings these clips were rendered with. */
  caption: string
  onClose: () => void
}

/**
 * Before-and-after playback on one timeline.
 *
 * Two `<audio>` elements cannot answer the only question that matters — does this
 * setting help *here* — because they keep separate playheads, so hearing the same
 * half-second both ways means hunting for it twice. Here both clips are decoded
 * and played together, muted against each other: switching crossfades between two
 * sources that are already at the same position, so the comparison is instant and
 * the audio never restarts.
 */
export function AbPlayer({ original, cleaned, name, caption, onClose }: AbPlayerProps) {
  const [side, setSide] = useState<AbSide>('cleaned')
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [loop, setLoop] = useState(true)
  const [matchLevels, setMatchLevels] = useState(false)

  const duration = Math.max(original.duration, cleaned.duration)
  const originalChannels = useMemo(() => channelsOf(original), [original])
  const cleanedChannels = useMemo(() => channelsOf(cleaned), [cleaned])
  const matchGain = useMemo(
    () => levelMatchGain(originalChannels, cleanedChannels),
    [originalChannels, cleanedChannels]
  )
  const originalPath = useMemo(() => pathFor(originalChannels), [originalChannels])
  const cleanedPath = useMemo(() => pathFor(cleanedChannels), [cleanedChannels])

  const graph = useRef<AbGraphHandle | null>(null)
  const frame = useRef(0)
  // Read inside callbacks that outlive the render they were created in.
  const settings = useRef({ side, loop, matchLevels, matchGain, duration })
  settings.current = { side, loop, matchLevels, matchGain, duration }

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current)
    graph.current?.dispose()
    graph.current = null
  }, [])

  /** Applies the current side to an existing graph, crossfading unless told not to. */
  const applySide = useCallback((next: AbSide, immediate: boolean) => {
    const active = graph.current
    if (!active) return
    const { matchLevels: matching, matchGain: gain } = settings.current
    active.setGains(
      next === 'original' ? 1 : 0,
      next === 'cleaned' ? (matching ? gain : 1) : 0,
      immediate ? 0 : CROSSFADE_SECONDS
    )
  }, [])

  const play = useCallback(async (from: number) => {
    stop()
    const context = getAudioContext()
    // A context created before any gesture starts suspended, and a suspended
    // context's clock does not advance, which would freeze the playhead.
    if (context.state === 'suspended') await context.resume()

    const active = createAbGraph(context, original, cleaned, settings.current.loop)
    graph.current = active
    applySide(settings.current.side, true)

    active.onEnded = () => {
      // Only reached with looping off: the clip ran to its end on its own.
      stop()
      setPlaying(false)
      setPosition(settings.current.duration)
    }
    active.start(clampTime(from, settings.current.duration))
    setPlaying(true)

    const tick = (): void => {
      const elapsed = active.elapsed()
      const total = settings.current.duration
      setPosition(settings.current.loop && total > 0 ? elapsed % total : Math.min(elapsed, total))
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [applySide, cleaned, original, stop])

  const toggle = useCallback(() => {
    if (playing) {
      stop()
      setPlaying(false)
      return
    }
    // Restarting from the end is what a person means by pressing play there.
    void play(position >= duration - 0.01 ? 0 : position)
  }, [duration, play, playing, position, stop])

  const seek = useCallback((seconds: number) => {
    const target = clampTime(seconds, duration)
    setPosition(target)
    if (playing) void play(target)
  }, [duration, play, playing])

  const chooseSide = useCallback((next: AbSide) => {
    setSide(next)
    applySide(next, false)
  }, [applySide])

  // Live changes to a graph that is already running.
  useEffect(() => { graph.current?.setLoop(loop) }, [loop])
  // Level matching only. A side change is handled by `chooseSide`, which crossfades;
  // reapplying it here would snap the gains and undo that fade.
  useEffect(() => { applySide(settings.current.side, true) }, [applySide, matchLevels])
  // The clips are replaced when a new preview is rendered, so playback stops with them.
  useEffect(() => stop, [stop, original, cleaned])

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 5 : 1
    const keys: Record<string, () => void> = {
      ' ': toggle,
      k: toggle,
      b: () => chooseSide(side === 'cleaned' ? 'original' : 'cleaned'),
      l: () => setLoop((value) => !value),
      ArrowLeft: () => seek(position - step),
      ArrowRight: () => seek(position + step),
      Home: () => seek(0),
      End: () => seek(duration)
    }
    const action = keys[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  return (
    <section className="preview-card ab-player" aria-label="Before and after preview">
      <div className="preview-head">
        <span className="panel-chip"><AudioLines size={19} /></span>
        <div>
          <strong title={name}>{name}</strong>
          <span>{caption}</span>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close preview">
          <X size={16} />
        </button>
      </div>

      <div className="ab-stage" role="slider" tabIndex={0} aria-label="Playback position"
        aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(position)}
        aria-valuetext={`${formatClock(position)} of ${formatClock(duration)}`}
        onKeyDown={handleKey}
        onPointerDown={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          if (bounds.width > 0) seek(((event.clientX - bounds.left) / bounds.width) * duration)
        }}>
        <Waveform label="Original" icon={<Volume2 size={12} />} path={originalPath} active={side === 'original'} />
        <Waveform label="Cleaned" icon={<AudioLines size={12} />} path={cleanedPath} active={side === 'cleaned'} />
        <span className="ab-playhead" style={{ left: `${duration > 0 ? (position / duration) * 100 : 0}%` }} aria-hidden="true" />
      </div>

      <div className="ab-transport">
        <button className="ab-play" type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <span className="ab-clock">{formatClock(position)} <i>/</i> {formatClock(duration)}</span>

        <div className="ab-switch" role="group" aria-label="Version to listen to">
          <button type="button" aria-pressed={side === 'original'}
            className={side === 'original' ? 'selected' : ''}
            onClick={() => chooseSide('original')}>Original</button>
          <button type="button" aria-pressed={side === 'cleaned'}
            className={side === 'cleaned' ? 'selected' : ''}
            onClick={() => chooseSide('cleaned')}>Cleaned</button>
        </div>

        <button className={`ab-toggle ${loop ? 'on' : ''}`} type="button" aria-pressed={loop}
          onClick={() => setLoop((value) => !value)} title="Loop the clip">
          <Repeat size={14} /> Loop
        </button>
        <button className={`ab-toggle ${matchLevels ? 'on' : ''}`} type="button" aria-pressed={matchLevels}
          onClick={() => setMatchLevels((value) => !value)}
          title="Play both versions at the same loudness, so the difference you hear is the noise and not the volume">
          <Scale size={14} /> Match levels
        </button>
      </div>

      <p className="setting-note">
        Press <kbd>B</kbd> to flip versions at the same instant, <kbd>Space</kbd> to play, arrows to seek.
        {matchLevels
          ? ' Levels are matched, so this is the difference in noise rather than in volume.'
          : ' The louder version usually sounds better — match levels to rule that out.'}
      </p>
    </section>
  )
}

function Waveform({ label, icon, path, active }: {
  label: string
  icon: ReactNode
  path: string
  active: boolean
}) {
  return (
    <div className={`ab-wave ${active ? 'active' : ''}`}>
      <span className="ab-wave-label">{icon} {label}</span>
      <svg viewBox={`0 0 ${WAVEFORM_COLUMNS} ${WAVEFORM_HEIGHT}`} preserveAspectRatio="none"
        aria-hidden="true" focusable="false">
        <path d={path} />
      </svg>
    </div>
  )
}

function pathFor(channels: Float32Array[]): string {
  return peaksToPath(computePeaks(channels, WAVEFORM_COLUMNS), WAVEFORM_HEIGHT)
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
}

function clampTime(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds)) return 0
  return Math.min(Math.max(0, seconds), Math.max(0, duration))
}
