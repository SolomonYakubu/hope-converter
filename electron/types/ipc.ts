import type {
  ConversionProgress,
  ConversionRequest,
  ConversionResult,
  HardwareCapabilities,
  MediaKind,
  MediaMetadata
} from './conversion'

export const IPC_CHANNELS = {
  convertFile: 'convert-file',
  cancelConversion: 'cancel-conversion',
  pauseConversion: 'pause-conversion',
  resumeConversion: 'resume-conversion',
  probeMedia: 'probe-media',
  getFFmpegVersion: 'get-ffmpeg-version',
  detectHardware: 'detect-hardware',
  pickInputFiles: 'pick-input-files',
  pickOutputFolder: 'pick-output-folder',
  openOutputFolder: 'open-output-folder',
  conversionProgress: 'conversion-progress',
  conversionComplete: 'conversion-complete',
  conversionCancelled: 'conversion-cancelled',
  conversionError: 'conversion-error'
} as const

export interface ConversionErrorPayload {
  id: string
  message: string
}

export interface ConversionCancelledPayload {
  id: string
}

export interface SelectedInputFile {
  path: string
  name: string
  size: number
  kind: MediaKind
}

export interface HopeConverterAPI {
  selectFiles: () => Promise<SelectedInputFile[]>
  getPathForFile: (file: File) => string
  selectOutputDirectory: () => Promise<string | null>
  getFFmpegVersion: () => Promise<string>
  detectHardware: () => Promise<HardwareCapabilities>
  probeMedia: (inputPath: string) => Promise<MediaMetadata>
  convert: (request: ConversionRequest) => Promise<void>
  cancel: (id: string) => Promise<boolean>
  pause: (id: string) => Promise<boolean>
  resume: (id: string) => Promise<boolean>
  showItemInFolder: (outputPath: string) => Promise<void>
  onProgress: (listener: (progress: ConversionProgress) => void) => () => void
  onComplete: (listener: (result: ConversionResult) => void) => () => void
  onCancelled: (listener: (payload: ConversionCancelledPayload) => void) => () => void
  onError: (listener: (error: ConversionErrorPayload) => void) => () => void
}
