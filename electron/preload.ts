import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  ConversionProgress,
  ConversionRequest,
  ConversionResult,
  HardwareCapabilities,
  MediaMetadata
} from './types/conversion'
import {
  IPC_CHANNELS,
  type ConversionCancelledPayload,
  type ConversionErrorPayload,
  type HopeConverterAPI,
  type SelectedInputFile
} from './types/ipc'
import { describeIpcError } from './utils/ipc-error'

/** Invokes a main-process handler, surfacing readable messages to the UI. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args) as T
  } catch (cause) {
    throw describeIpcError(cause)
  }
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.removeListener(channel, handler) }
}

const api: HopeConverterAPI = {
  selectFiles: () => invoke<SelectedInputFile[]>(IPC_CHANNELS.pickInputFiles),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  selectOutputDirectory: () => invoke<string | null>(IPC_CHANNELS.pickOutputFolder),
  getFFmpegVersion: () => invoke<string>(IPC_CHANNELS.getFFmpegVersion),
  detectHardware: () => invoke<HardwareCapabilities>(IPC_CHANNELS.detectHardware),
  probeMedia: (inputPath: string) => invoke<MediaMetadata>(IPC_CHANNELS.probeMedia, inputPath),
  convert: async (request: ConversionRequest) => {
    await invoke<void>(IPC_CHANNELS.convertFile, request)
  },
  cancel: (id: string) => invoke<boolean>(IPC_CHANNELS.cancelConversion, id),
  pause: (id: string) => invoke<boolean>(IPC_CHANNELS.pauseConversion, id),
  resume: (id: string) => invoke<boolean>(IPC_CHANNELS.resumeConversion, id),
  showItemInFolder: (outputPath: string) => invoke<void>(IPC_CHANNELS.openOutputFolder, outputPath),
  onProgress: (listener: (progress: ConversionProgress) => void) =>
    subscribe(IPC_CHANNELS.conversionProgress, listener),
  onComplete: (listener: (result: ConversionResult) => void) =>
    subscribe(IPC_CHANNELS.conversionComplete, listener),
  onCancelled: (listener: (payload: ConversionCancelledPayload) => void) =>
    subscribe(IPC_CHANNELS.conversionCancelled, listener),
  onError: (listener: (error: ConversionErrorPayload) => void) =>
    subscribe(IPC_CHANNELS.conversionError, listener)
}

contextBridge.exposeInMainWorld('hopeConverter', api)
