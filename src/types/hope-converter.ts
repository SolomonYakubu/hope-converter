import type {
  ConversionCancelledPayload,
  ConversionErrorPayload,
  HopeConverterAPI,
  SelectedInputFile
} from '../../electron/types/ipc'

/**
 * The renderer speaks to the main process through the preload bridge only, so
 * these aliases keep a single source of truth for the exposed contract.
 */
export type InputFile = SelectedInputFile
export type ConversionError = ConversionErrorPayload
export type ConversionCancelled = ConversionCancelledPayload
export type HopeConverterApi = HopeConverterAPI
