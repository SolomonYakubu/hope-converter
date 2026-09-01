import type {
  ConversionProgress,
  ConversionRequest,
  ConversionResult,
  HardwareCapabilities,
  MediaKind,
  MediaMetadata
} from './conversion'
import type {
  DenoiseEngineInfo,
  DenoisePreviewRequest,
  DenoisePreviewResult,
  DenoiseProgress,
  DenoiseResult,
  DenoiseStartRequest
} from './denoise'

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
  conversionError: 'conversion-error',
  denoiseInfo: 'denoise-info',
  denoiseFile: 'denoise-file',
  cancelDenoise: 'cancel-denoise',
  denoisePreview: 'denoise-preview',
  denoiseProgress: 'denoise-progress',
  denoiseComplete: 'denoise-complete',
  denoiseCancelled: 'denoise-cancelled',
  denoiseError: 'denoise-error'
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
  getDenoiseInfo: () => Promise<DenoiseEngineInfo>
  denoise: (request: DenoiseStartRequest) => Promise<void>
  cancelDenoise: (id: string) => Promise<boolean>
  previewDenoise: (request: DenoisePreviewRequest) => Promise<DenoisePreviewResult>
  onDenoiseProgress: (listener: (progress: DenoiseProgress) => void) => () => void
  onDenoiseComplete: (listener: (result: DenoiseResult) => void) => () => void
  onDenoiseCancelled: (listener: (payload: ConversionCancelledPayload) => void) => () => void
  onDenoiseError: (listener: (error: ConversionErrorPayload) => void) => () => void
}
