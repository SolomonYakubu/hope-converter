export type MediaKind = 'video' | 'audio' | 'image'

export type VideoCodec = 'libx264' | 'libx265' | 'libvpx-vp9' | 'copy' | 'h264_videotoolbox' | 'h264_nvenc' | 'hevc_nvenc' | 'h264_qsv'
export type AudioCodec = 'aac' | 'libmp3lame' | 'libopus' | 'flac' | 'pcm_s16le' | 'copy'
export type VideoPreset = 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow'
export type ImageFormat = 'jpg' | 'png' | 'webp'

export interface VideoConversionOptions {
  kind: 'video'
  videoCodec: VideoCodec
  crf?: number
  preset?: VideoPreset
  width?: number
  height?: number
  fps?: number
  audioCodec?: AudioCodec
  audioBitrateKbps?: number
  fastStart?: boolean
}

export interface AudioConversionOptions {
  kind: 'audio'
  audioCodec: AudioCodec
  bitrateKbps?: number
  sampleRate?: 22_050 | 44_100 | 48_000 | 96_000
  channels?: 1 | 2
}

export interface ImageConversionOptions {
  kind: 'image'
  format: ImageFormat
  quality?: number
  width?: number
  height?: number
  keepAspectRatio?: boolean
}

export type ConversionOptions = VideoConversionOptions | AudioConversionOptions | ImageConversionOptions

export interface ConversionRequest {
  id: string
  inputPath: string
  outputPath: string
  durationSeconds?: number
  options: ConversionOptions
}

export interface ConversionProgress {
  id: string
  frame: number | null
  timeSeconds: number
  percent: number
  speed: number | null
  state: 'continue' | 'end'
}

export interface ConversionResult {
  id: string
  outputPath: string
}

export interface MediaMetadata {
  duration?: number
  container?: string
  videoCodec?: string
  audioCodec?: string
  width?: number
  height?: number
  fps?: number
  audioSampleRate?: number
  audioChannels?: number
  /**
   * Stream counts by type, absent when the file has none of that type.
   *
   * The denoise panel needs them to say which streams a remux will not carry, so
   * a dropped subtitle track is named beforehand rather than discovered afterwards.
   */
  videoTracks?: number
  audioTracks?: number
  subtitleTracks?: number
}

export interface HardwareCapabilities {
  encoders: VideoCodec[]
  preferredEncoder: VideoCodec | null
}
