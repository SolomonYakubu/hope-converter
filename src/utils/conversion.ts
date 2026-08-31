import type { ConversionOptions, MediaKind, VideoCodec } from '../../electron/types/conversion'
import type { OutputFormats, QualityPreset } from '../stores/conversion-store'
import type { InputFile } from '../types/hope-converter'

export const FORMAT_OPTIONS: Record<MediaKind, readonly { value: string; label: string }[]> = {
  video: [
    { value: 'mp4', label: 'MP4' }, { value: 'webm', label: 'WebM' }, { value: 'mov', label: 'MOV' }
  ],
  audio: [
    { value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' },
    { value: 'flac', label: 'FLAC' }, { value: 'm4a', label: 'M4A' }
  ],
  image: [
    { value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }
  ]
}

export function classifyDroppedFile(file: File): MediaKind | null {
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv'].includes(extension ?? '')) return 'video'
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma'].includes(extension ?? '')) return 'audio'
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'tif', 'tiff', 'bmp', 'gif'].includes(extension ?? '')) return 'image'
  return null
}

export function createInputFileFromDrop(
  file: File,
  getPathForFile: (file: File) => string
): InputFile | null {
  const kind = classifyDroppedFile(file)
  if (!kind) return null

  const path = getPathForFile(file).trim()
  if (!path) return null

  return { path, name: file.name, size: file.size, kind }
}

export function createOutputPath(file: InputFile, outputDirectory: string, extension: string): string {
  const separator = outputDirectory.includes('\\') ? '\\' : '/'
  const directory = outputDirectory.replace(/[\\/]$/, '')
  const baseName = file.name.replace(/\.[^.]+$/, '')
  return `${directory}${separator}${baseName}-converted.${extension}`
}

export function createConversionOptions(
  kind: MediaKind,
  formats: OutputFormats,
  quality: QualityPreset,
  preferredEncoder: VideoCodec | null = null,
  performanceMode = false
): ConversionOptions {
  if (kind === 'video') {
    const crf = quality === 'high' ? 18 : quality === 'balanced' ? 23 : 28
    const preset = quality === 'high' ? 'slow' : quality === 'balanced' ? 'medium' : 'veryfast'
    const format = formats.video
    const hardwareEncoder = performanceMode && format !== 'webm' && isHardwareEncoder(preferredEncoder)
      ? preferredEncoder
      : null
    return {
      kind: 'video',
      videoCodec: hardwareEncoder ?? (format === 'webm' ? 'libvpx-vp9' : 'libx264'),
      audioCodec: format === 'webm' ? 'libopus' : 'aac',
      crf,
      preset,
      fastStart: format !== 'webm'
    }
  }

  if (kind === 'audio') {
    const format = formats.audio
    const bitrateKbps = quality === 'high' ? 320 : quality === 'balanced' ? 192 : 128
    return {
      kind: 'audio',
      audioCodec: format === 'wav' ? 'pcm_s16le' : format === 'flac' ? 'flac' : format === 'm4a' ? 'aac' : 'libmp3lame',
      ...(format === 'wav' || format === 'flac' ? {} : { bitrateKbps }),
      sampleRate: 48_000,
      channels: 2
    }
  }

  return {
    kind: 'image',
    format: formats.image,
    quality: quality === 'high' ? 95 : quality === 'balanced' ? 85 : 70,
    keepAspectRatio: true
  }
}

function isHardwareEncoder(codec: VideoCodec | null): codec is VideoCodec {
  return codec !== null && ['h264_videotoolbox', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv'].includes(codec)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}
