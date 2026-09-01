import { extname } from 'node:path'
import {
  DENOISE_LOUDNESS_TARGET_LUFS,
  DENOISE_MAX_SPEECH_GAIN_DB,
  DENOISE_SAMPLE_RATE,
  type DenoiseAudioFormat,
  type DenoiseKind
} from '../types/denoise'

const AUDIO_ENCODERS: Record<DenoiseAudioFormat, { codec: string; lossy: boolean }> = {
  wav: { codec: 'pcm_s16le', lossy: false },
  flac: { codec: 'flac', lossy: false },
  mp3: { codec: 'libmp3lame', lossy: true },
  m4a: { codec: 'aac', lossy: true }
}

/**
 * How each video container is rebuilt. The video stream is always copied, never
 * re-encoded, so the audio codec has to be one the container accepts.
 *
 * Containers that mux modern audio poorly (AVI, FLV, WMV) are written to
 * Matroska instead — still a straight copy of the original video, just in a
 * wrapper that takes AAC without complaint.
 */
const VIDEO_CONTAINERS: Record<string, { extension: string; codec: string }> = {
  mp4: { extension: 'mp4', codec: 'aac' },
  m4v: { extension: 'm4v', codec: 'aac' },
  mov: { extension: 'mov', codec: 'aac' },
  mkv: { extension: 'mkv', codec: 'aac' },
  webm: { extension: 'webm', codec: 'libopus' },
  avi: { extension: 'mkv', codec: 'aac' },
  flv: { extension: 'mkv', codec: 'aac' },
  wmv: { extension: 'mkv', codec: 'aac' }
}

export interface DecodeArgsOptions {
  inputPath: string
  channels: number
  /** Optional window, used by the A/B preview. */
  startSeconds?: number
  durationSeconds?: number
}

export interface LevelOptions {
  /** Speech lift in dB. 0, or absent, emits nothing. */
  speechGainDb?: number
  /** Normalizes the result to {@link DENOISE_LOUDNESS_TARGET_LUFS}. */
  normalizeLoudness?: boolean
}

export interface EncodeArgsOptions extends LevelOptions {
  outputPath: string
  channels: number
  kind: DenoiseKind
  /** Required for video, to copy the picture and the original tags across. */
  originalPath?: string
  audioFormat?: DenoiseAudioFormat
  audioBitrateKbps?: number
}

/**
 * The post-model level stage, or null when neither control is asking for one.
 *
 * The model has no level control, so loudness is FFmpeg's job and runs after the
 * denoising rather than inside it. Two filters, in this order:
 *
 * - `speechnorm` lifts quiet speech toward the peak. Its `e` is a plain amplitude
 *   ratio, so a dB figure maps onto it exactly as 10^(dB/20), and `p=0.95` keeps
 *   the result under full scale rather than clipping into it.
 * - `loudnorm` then sets the absolute integrated loudness. Measured single-pass,
 *   it lands within about 0.05 LUFS of the target even on material with a 22 LU
 *   range, which is close enough not to be worth a second pass over the audio.
 *
 * Returning null rather than a no-op chain matters: at 0 dB with normalizing off,
 * no `-af` reaches FFmpeg at all, so the output is what it was before this stage
 * existed instead of merely sounding like it.
 */
export function buildAudioFilterChain(options: LevelOptions): string | null {
  const filters: string[] = []
  const gainDb = options.speechGainDb ?? 0

  if (gainDb > 0) {
    if (!Number.isFinite(gainDb) || gainDb > DENOISE_MAX_SPEECH_GAIN_DB) {
      throw new Error(`speech gain must be between 0 and ${DENOISE_MAX_SPEECH_GAIN_DB} dB`)
    }
    filters.push(`speechnorm=e=${(10 ** (gainDb / 20)).toFixed(3)}:p=0.95`)
  }
  if (options.normalizeLoudness) {
    filters.push(`loudnorm=I=${DENOISE_LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11`)
  }

  return filters.length ? filters.join(',') : null
}

/**
 * Reads the first audio track and writes raw 48 kHz float samples to stdout,
 * which is exactly what the model consumes.
 */
export function buildDecodeArgs(options: DecodeArgsOptions): string[] {
  return [...buildReadArgs(options), '-f', 'f32le', 'pipe:1']
}

/**
 * Everything up to the sink: input, optional window, and the resampling that
 * puts the first audio track into the model's 48 kHz format.
 */
function buildReadArgs(options: DecodeArgsOptions): string[] {
  assertPath(options.inputPath, 'input path')
  assertChannels(options.channels)

  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error']
  if (options.startSeconds !== undefined) {
    assertSeconds(options.startSeconds, 'start time')
    args.push('-ss', formatSeconds(options.startSeconds))
  }
  args.push('-i', options.inputPath)
  if (options.durationSeconds !== undefined) {
    assertSeconds(options.durationSeconds, 'duration')
    if (options.durationSeconds <= 0) throw new Error('duration must be greater than zero')
    args.push('-t', formatSeconds(options.durationSeconds))
  }

  return [
    ...args,
    '-map', '0:a:0',
    '-vn', '-sn', '-dn',
    '-ac', String(options.channels),
    '-ar', String(DENOISE_SAMPLE_RATE)
  ]
}

/**
 * Takes denoised float samples on stdin and writes the finished file. For video
 * the original is read alongside so its picture is copied through untouched.
 */
export function buildEncodeArgs(options: EncodeArgsOptions): string[] {
  assertPath(options.outputPath, 'output path')
  assertChannels(options.channels)
  // Built before anything else so a bad level setting is rejected alongside the
  // paths, rather than after a process has already been spawned.
  const filterChain = buildAudioFilterChain(options)

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'f32le',
    '-ar', String(DENOISE_SAMPLE_RATE),
    '-ac', String(options.channels),
    '-i', 'pipe:0'
  ]

  if (options.kind === 'video') {
    if (!options.originalPath) throw new Error('A video needs its original file to copy the picture from')
    assertPath(options.originalPath, 'original path')

    const container = videoContainerFor(options.outputPath)
    args.push(
      '-i', options.originalPath,
      '-map', '1:v:0', '-map', '0:a:0',
      '-map_metadata', '1',
      '-c:v', 'copy'
    )
    // Only the soundtrack is filtered; the picture is still a straight copy.
    if (filterChain) args.push('-af', filterChain)
    args.push(
      '-c:a', container.codec,
      '-b:a', `${audioBitrate(options.audioBitrateKbps)}k`
    )
    if (container.extension === 'mp4' || container.extension === 'm4v' || container.extension === 'mov') {
      args.push('-movflags', '+faststart')
    }
    return [...args, options.outputPath]
  }

  const format = options.audioFormat ?? 'flac'
  const encoder = AUDIO_ENCODERS[format]
  if (!encoder) throw new Error(`Invalid audio format: ${String(format)}`)

  if (filterChain) args.push('-af', filterChain)
  args.push('-c:a', encoder.codec)
  if (encoder.lossy) args.push('-b:a', `${audioBitrate(options.audioBitrateKbps)}k`)
  return [...args, options.outputPath]
}

/** Writes a plain 16-bit WAV, used for the untouched half of the A/B preview. */
export function buildPreviewExtractArgs(options: DecodeArgsOptions & { outputPath: string }): string[] {
  assertPath(options.outputPath, 'output path')
  // Same read as the model gets, but written as a WAV the renderer's <audio> plays.
  return [...buildReadArgs(options), '-c:a', 'pcm_s16le', options.outputPath]
}

/**
 * The extension a denoised copy of `inputPath` should use. Video keeps its own
 * container where the container allows it; audio follows the chosen format.
 */
export function denoisedExtension(
  inputPath: string,
  kind: DenoiseKind,
  audioFormat: DenoiseAudioFormat = 'flac'
): string {
  if (kind === 'audio') {
    if (!AUDIO_ENCODERS[audioFormat]) throw new Error(`Invalid audio format: ${String(audioFormat)}`)
    return audioFormat
  }
  return videoContainerFor(inputPath).extension
}

function videoContainerFor(path: string): { extension: string; codec: string } {
  const extension = extname(path).slice(1).toLowerCase()
  const container = VIDEO_CONTAINERS[extension]
  if (!container) throw new Error(`Denoising does not support the ${extension || 'unknown'} container`)
  return container
}

function audioBitrate(bitrateKbps: number | undefined): number {
  const bitrate = bitrateKbps ?? 192
  if (!Number.isInteger(bitrate) || bitrate < 32 || bitrate > 512) {
    throw new Error('audio bitrate must be an integer between 32 and 512')
  }
  return bitrate
}

// Fixed notation keeps a value like 1e-7 out of the argument list.
function formatSeconds(value: number): string {
  return value.toFixed(3)
}

function assertSeconds(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`)
}

function assertChannels(channels: number): void {
  if (channels !== 1 && channels !== 2) throw new Error('channels must be 1 or 2')
}

function assertPath(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} cannot be empty`)
  if (value.includes('\u0000')) throw new Error(`${label} contains an invalid character`)
}
