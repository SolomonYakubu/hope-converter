import type {
  AudioCodec,
  ConversionOptions,
  ImageConversionOptions,
  VideoCodec,
  VideoConversionOptions,
  VideoPreset
} from '../types/conversion'
import { assertPath } from '../utils/guards'

const VIDEO_CODECS = new Set<VideoCodec>([
  'libx264', 'libx265', 'libvpx-vp9', 'copy',
  'h264_videotoolbox', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv'
])
const AUDIO_CODECS = new Set<AudioCodec>(['aac', 'libmp3lame', 'libopus', 'flac', 'pcm_s16le', 'copy'])
const VIDEO_PRESETS = new Set<VideoPreset>([
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'
])

export function buildFFmpegArgs(
  inputPath: string,
  outputPath: string,
  options: ConversionOptions
): string[] {
  assertPath(inputPath, 'input path')
  assertPath(outputPath, 'output path')

  const args = ['-y', '-i', inputPath]

  switch (options.kind) {
    case 'video':
      appendVideoArgs(args, options)
      break
    case 'audio':
      assertAllowed(AUDIO_CODECS, options.audioCodec, 'audio codec')
      args.push('-map', '0:a:0', '-vn', '-c:a', options.audioCodec)
      if (options.bitrateKbps !== undefined) {
        assertIntegerInRange(options.bitrateKbps, 8, 1_536, 'audio bitrate')
        args.push('-b:a', `${options.bitrateKbps}k`)
      }
      if (options.sampleRate !== undefined) args.push('-ar', String(options.sampleRate))
      if (options.channels !== undefined) args.push('-ac', String(options.channels))
      break
    case 'image':
      appendImageArgs(args, options)
      break
    default:
      throw new Error('Unsupported conversion kind')
  }

  return [...args, '-progress', 'pipe:2', '-nostats', outputPath]
}

function appendVideoArgs(args: string[], options: VideoConversionOptions): void {
  assertAllowed(VIDEO_CODECS, options.videoCodec, 'video codec')
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', options.videoCodec)

  if (options.videoCodec !== 'copy') {
    appendVideoQualityArgs(args, options)
    appendScale(args, options.width, options.height, true)
    if (options.fps !== undefined) {
      assertNumberInRange(options.fps, 1, 240, 'frame rate')
      args.push('-r', String(options.fps))
    }
  }

  if (options.audioCodec !== undefined) {
    assertAllowed(AUDIO_CODECS, options.audioCodec, 'audio codec')
    args.push('-c:a', options.audioCodec)
  }
  if (options.audioBitrateKbps !== undefined) {
    assertIntegerInRange(options.audioBitrateKbps, 8, 1_536, 'audio bitrate')
    args.push('-b:a', `${options.audioBitrateKbps}k`)
  }
  if (options.fastStart) args.push('-movflags', '+faststart')
}

function appendImageArgs(args: string[], options: ImageConversionOptions): void {
  if (!['jpg', 'png', 'webp'].includes(options.format)) throw new Error('Invalid image format')
  args.push('-map', '0:v:0')
  appendScale(args, options.width, options.height, options.keepAspectRatio ?? true)

  if (options.quality !== undefined) {
    assertIntegerInRange(options.quality, 1, 100, 'image quality')
    if (options.format === 'webp') args.push('-quality', String(options.quality))
    if (options.format === 'jpg') args.push('-q:v', String(Math.round(31 - (options.quality / 100) * 29)))
  }

  args.push('-frames:v', '1')
}

function appendScale(args: string[], width?: number, height?: number, keepAspectRatio = true): void {
  if (width === undefined && height === undefined) return
  if (width !== undefined) assertIntegerInRange(width, 16, 16_384, 'width')
  if (height !== undefined) assertIntegerInRange(height, 16, 16_384, 'height')

  const targetWidth = width ?? (keepAspectRatio ? -2 : -1)
  const targetHeight = height ?? (keepAspectRatio ? -2 : -1)
  args.push('-vf', `scale=${targetWidth}:${targetHeight}`)
}

function appendVideoQualityArgs(args: string[], options: VideoConversionOptions): void {
  if (options.crf !== undefined) assertIntegerInRange(options.crf, 0, 51, 'CRF')
  if (options.preset !== undefined) assertAllowed(VIDEO_PRESETS, options.preset, 'video preset')

  if (options.videoCodec === 'h264_videotoolbox') {
    if (options.crf !== undefined) {
      const quality = 100 - Math.round((options.crf / 51) * 100)
      args.push('-q:v', String(quality))
    }
    return
  }

  if (options.videoCodec === 'h264_nvenc' || options.videoCodec === 'hevc_nvenc') {
    if (options.preset !== undefined) args.push('-preset', nvencPreset(options.preset))
    if (options.crf !== undefined) args.push('-rc', 'vbr', '-cq:v', String(options.crf), '-b:v', '0')
    return
  }

  if (options.videoCodec === 'h264_qsv') {
    if (options.preset !== undefined) args.push('-preset', options.preset)
    if (options.crf !== undefined) args.push('-global_quality', String(options.crf))
    return
  }

  if (options.videoCodec === 'libvpx-vp9') {
    if (options.crf !== undefined) args.push('-b:v', '0', '-crf', String(options.crf))
    if (options.preset !== undefined) {
      args.push('-deadline', 'good', '-cpu-used', String(vp9CpuUsed(options.preset)))
    }
    return
  }

  if (options.crf !== undefined) args.push('-crf', String(options.crf))
  if (options.preset !== undefined) args.push('-preset', options.preset)
}

function nvencPreset(preset: VideoPreset): string {
  const presetMap: Record<VideoPreset, string> = {
    ultrafast: 'p1',
    superfast: 'p1',
    veryfast: 'p2',
    faster: 'p3',
    fast: 'p3',
    medium: 'p4',
    slow: 'p6',
    slower: 'p6',
    veryslow: 'p7'
  }
  return presetMap[preset]
}

function vp9CpuUsed(preset: VideoPreset): number {
  const speedByPreset: Record<VideoPreset, number> = {
    ultrafast: 6,
    superfast: 6,
    veryfast: 6,
    faster: 5,
    fast: 5,
    medium: 4,
    slow: 3,
    slower: 2,
    veryslow: 1
  }
  return speedByPreset[preset]
}

function assertAllowed<T>(allowed: ReadonlySet<T>, value: T, label: string): void {
  if (!allowed.has(value)) throw new Error(`Invalid ${label}`)
}

function assertIntegerInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
  }
}

function assertNumberInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`)
  }
}
