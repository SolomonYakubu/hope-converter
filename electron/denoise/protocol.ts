/**
 * Messages exchanged with the denoise worker thread. The worker owns the model
 * and both FFmpeg processes; the main thread only forwards requests and relays
 * events to the renderer.
 */
import type {
  DenoiseOptions,
  DenoisePreviewRequest,
  DenoisePreviewResult,
  DenoiseProgress,
  DenoiseRequest,
  DenoiseResult
} from '../types/denoise'

/** Handed to the worker at construction; it never resolves these itself. */
export interface DenoiseWorkerData {
  assetDirectory: string
  ffmpegPath: string
  /** Initial model settings, replaced per job. */
  options: DenoiseOptions
}

export interface DenoiseJobMessage {
  type: 'job'
  request: DenoiseRequest
  /** Resolved by the main thread from the probe, never guessed in the worker. */
  channels: number
}

export interface DenoisePreviewMessage {
  type: 'preview'
  request: DenoisePreviewRequest
  channels: number
}

export interface DenoiseCancelMessage {
  type: 'cancel'
  id: string
}

export type DenoiseWorkerRequest = DenoiseJobMessage | DenoisePreviewMessage | DenoiseCancelMessage

export type DenoiseWorkerEvent =
  | { type: 'ready', frameLength: number }
  | { type: 'unavailable', reason: string }
  | { type: 'progress', progress: DenoiseProgress }
  | { type: 'done', result: DenoiseResult }
  | { type: 'preview', result: DenoisePreviewResult }
  | { type: 'failed', id: string, message: string }
  | { type: 'cancelled', id: string }
