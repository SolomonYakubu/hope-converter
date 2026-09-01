import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { denoisedExtension } from './denoise/command-builder'
import { DenoiseService } from './denoise/service'
import { buildFFmpegArgs } from './ffmpeg/command-builder'
import { ConverterService } from './ffmpeg/converter'
import { detectHardwareEncoders, getFFmpegVersion } from './ffmpeg/hardware'
import { probeMedia } from './ffmpeg/probe'
import type { ConversionRequest } from './types/conversion'
import type {
  DenoiseAudioFormat,
  DenoiseOptions,
  DenoisePreviewRequest,
  DenoiseRequest,
  DenoiseStartRequest
} from './types/denoise'
import { IPC_CHANNELS } from './types/ipc'
import { classifyMedia, createOutputPath, isSupportedInput } from './utils/file'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const converter = new ConverterService()
// Both paths are resolved here rather than inside the service: this file is the
// build's entry point, so it is the one module whose location the bundler will
// not move into a chunk under `out/main/chunks/`.
const denoiser = new DenoiseService({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  workerPath: new URL('denoise-worker.js', import.meta.url)
})
let mainWindow: BrowserWindow | null = null

const DENOISE_AUDIO_FORMATS: ReadonlySet<string> = new Set<DenoiseAudioFormat>(['wav', 'flac', 'mp3', 'm4a'])

// Packaged builds take their icon from electron-builder, but the source PNG
// still dresses the window and taskbar while developing on Windows and Linux.
function resolveWindowIcon(): string | undefined {
  const iconPath = join(currentDirectory, '../../resources/icon.png')
  return existsSync(iconPath) ? iconPath : undefined
}

function createWindow(): void {
  // Opens in native fullscreen: no menu bar, no title bar, its own Space on macOS.
  // The work-area bounds are what the window returns to on leaving fullscreen, so
  // it lands maximized rather than at some small default.
  const { workArea } = screen.getPrimaryDisplay()
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 900,
    minHeight: 600,
    fullscreen: true,
    show: false,
    backgroundColor: '#0b0810',
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: join(currentDirectory, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // DevTools stay available while developing, but a shipped build should not
      // hand out an inspector for the renderer.
      devTools: !app.isPackaged
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.once('did-finish-load', () => {
    if (!app.isPackaged) void verifyPreloadBridge(mainWindow)
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void mainWindow.loadURL(rendererUrl)
  else void mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'))
}

async function verifyPreloadBridge(window: BrowserWindow | null): Promise<void> {
  if (!window || window.isDestroyed()) return
  const isReady = await window.webContents.executeJavaScript(
    "typeof window.hopeConverter === 'object'",
    true
  ) as boolean
  if (isReady) console.info('[Hope Converter] Preload bridge ready')
  else console.error('[Hope Converter] Preload bridge failed to load')
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.pickInputFiles, async () => {
    const result = await showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: 'Supported media',
        extensions: [
          'mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv',
          'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma',
          'jpg', 'jpeg', 'png', 'webp', 'heic', 'tif', 'tiff', 'bmp', 'gif'
        ]
      }]
    })
    if (result.canceled) return []
    return await Promise.all(result.filePaths.filter(isSupportedInput).map(async (path) => {
      const kind = classifyMedia(path)
      if (!kind) throw new Error('Unsupported input file type')
      return { path, name: basename(path), size: (await stat(path)).size, kind }
    }))
  })

  ipcMain.handle(IPC_CHANNELS.pickOutputFolder, async () => {
    const result = await showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.getFFmpegVersion, () => getFFmpegVersion())
  ipcMain.handle(IPC_CHANNELS.detectHardware, () => detectHardwareEncoders())
  ipcMain.handle(IPC_CHANNELS.cancelConversion, (_event, id: unknown) => {
    assertNonEmptyString(id, 'conversion id')
    return converter.cancel(id)
  })
  ipcMain.handle(IPC_CHANNELS.pauseConversion, (_event, id: unknown) => {
    assertNonEmptyString(id, 'conversion id')
    return converter.pause(id)
  })
  ipcMain.handle(IPC_CHANNELS.resumeConversion, (_event, id: unknown) => {
    assertNonEmptyString(id, 'conversion id')
    return converter.resume(id)
  })
  ipcMain.handle(IPC_CHANNELS.probeMedia, (_event, inputPath: unknown) => {
    assertNonEmptyString(inputPath, 'input path')
    assertSafePath(inputPath, 'input path')
    if (!isSupportedInput(inputPath)) throw new Error('Unsupported input file type')
    return probeMedia(inputPath)
  })
  ipcMain.handle(IPC_CHANNELS.convertFile, async (event, payload: unknown) => {
    const request = validateConversionRequest(payload)
    try {
      await converter.convert(request, {
        onProgress: (progress) => sendIfAvailable(event.sender, IPC_CHANNELS.conversionProgress, progress),
        onComplete: (result) => sendIfAvailable(event.sender, IPC_CHANNELS.conversionComplete, result),
        onCancelled: (id) => sendIfAvailable(event.sender, IPC_CHANNELS.conversionCancelled, { id }),
        onError: (id, error) => sendIfAvailable(event.sender, IPC_CHANNELS.conversionError, { id, message: error.message })
      })
    } catch {
      // Runtime outcomes reach the renderer through the callbacks above, so the
      // invoke settles quietly instead of duplicating the failure.
    }
  })
  ipcMain.handle(IPC_CHANNELS.openOutputFolder, async (_event, outputPath: unknown) => {
    assertNonEmptyString(outputPath, 'output path')
    assertSafePath(outputPath, 'output path')
    shell.showItemInFolder(outputPath)
  })

  ipcMain.handle(IPC_CHANNELS.denoiseInfo, () => denoiser.info())
  ipcMain.handle(IPC_CHANNELS.cancelDenoise, (_event, id: unknown) => {
    assertNonEmptyString(id, 'denoise id')
    return denoiser.cancel(id)
  })
  ipcMain.handle(IPC_CHANNELS.denoiseFile, async (_event, payload: unknown) => {
    const request = validateDenoiseRequest(payload)
    try {
      await denoiser.denoise(request)
    } catch {
      // The outcome already reached the renderer through the service events.
    }
  })
  ipcMain.handle(IPC_CHANNELS.denoisePreview, (_event, payload: unknown) => {
    return denoiser.preview(validateDenoisePreviewRequest(payload))
  })

  denoiser.on('progress', (progress) => broadcast(IPC_CHANNELS.denoiseProgress, progress))
  denoiser.on('complete', (result) => broadcast(IPC_CHANNELS.denoiseComplete, result))
  denoiser.on('cancelled', (id) => broadcast(IPC_CHANNELS.denoiseCancelled, { id }))
  denoiser.on('error', (id, error) => broadcast(IPC_CHANNELS.denoiseError, { id, message: error.message }))
}

function showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  return mainWindow
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options)
}

function validateConversionRequest(payload: unknown): ConversionRequest {
  if (!isRecord(payload)) throw new Error('Invalid conversion request')
  assertNonEmptyString(payload.id, 'conversion id')
  assertNonEmptyString(payload.inputPath, 'input path')
  assertNonEmptyString(payload.outputPath, 'output path')
  assertSafePath(payload.inputPath, 'input path')
  assertSafePath(payload.outputPath, 'output path')
  if (!isSupportedInput(payload.inputPath)) throw new Error('Unsupported input file type')
  if (!isRecord(payload.options)) throw new Error('Invalid conversion options')
  if (payload.durationSeconds !== undefined && (
    typeof payload.durationSeconds !== 'number' ||
    !Number.isFinite(payload.durationSeconds) ||
    payload.durationSeconds <= 0
  )) throw new Error('Invalid media duration')

  const request = payload as unknown as ConversionRequest
  buildFFmpegArgs(request.inputPath, request.outputPath, request.options)
  return request
}

/**
 * Turns a renderer request into a job, choosing the destination filename here
 * rather than trusting one from the renderer: only this side knows which
 * container a given video can carry a re-encoded soundtrack in.
 */
function validateDenoiseRequest(payload: unknown): DenoiseRequest {
  if (!isRecord(payload)) throw new Error('Invalid denoise request')
  assertNonEmptyString(payload.id, 'denoise id')
  assertNonEmptyString(payload.inputPath, 'input path')
  assertNonEmptyString(payload.outputDirectory, 'output folder')
  assertSafePath(payload.inputPath, 'input path')
  assertSafePath(payload.outputDirectory, 'output folder')

  const kind = classifyMedia(payload.inputPath)
  if (kind !== 'audio' && kind !== 'video') throw new Error('Only audio and video files can be denoised')

  const request = payload as unknown as DenoiseStartRequest
  const audioFormat = request.audioFormat
  if (audioFormat !== undefined && !DENOISE_AUDIO_FORMATS.has(audioFormat)) {
    throw new Error('Invalid denoise output format')
  }
  if (request.audioBitrateKbps !== undefined && (
    !Number.isInteger(request.audioBitrateKbps) ||
    request.audioBitrateKbps < 32 ||
    request.audioBitrateKbps > 512
  )) throw new Error('Invalid audio bitrate')

  const extension = denoisedExtension(request.inputPath, kind, audioFormat)
  return {
    id: request.id,
    inputPath: request.inputPath,
    outputPath: createOutputPath(
      request.inputPath,
      request.outputDirectory,
      extension,
      `${parse(request.inputPath).name}-denoised`
    ),
    kind,
    audioFormat,
    audioBitrateKbps: request.audioBitrateKbps,
    options: validateDenoiseOptions(payload.options)
  }
}

function validateDenoisePreviewRequest(payload: unknown): DenoisePreviewRequest {
  if (!isRecord(payload)) throw new Error('Invalid preview request')
  assertNonEmptyString(payload.id, 'denoise id')
  assertNonEmptyString(payload.inputPath, 'input path')
  assertSafePath(payload.inputPath, 'input path')
  const kind = classifyMedia(payload.inputPath)
  if (kind !== 'audio' && kind !== 'video') throw new Error('Only audio and video files can be denoised')

  return {
    id: payload.id,
    inputPath: payload.inputPath,
    startSeconds: assertFiniteNumber(payload.startSeconds, 'preview start'),
    durationSeconds: assertFiniteNumber(payload.durationSeconds, 'preview length'),
    options: validateDenoiseOptions(payload.options)
  }
}

// The service clamps these to the model's usable ranges; this only rejects
// values that are not numbers at all.
function validateDenoiseOptions(payload: unknown): DenoiseOptions {
  if (!isRecord(payload)) throw new Error('Invalid denoise options')
  return {
    attenuationLimitDb: assertFiniteNumber(payload.attenuationLimitDb, 'noise reduction strength'),
    postFilterBeta: assertFiniteNumber(payload.postFilterBeta, 'post-filter beta'),
    speechGainDb: assertFiniteNumber(payload.speechGainDb, 'speech volume'),
    normalizeLoudness: payload.normalizeLoudness === true
  }
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a number`)
  return value
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
}

function assertSafePath(value: string, label: string): void {
  if (value.includes('\u0000')) throw new Error(`${label} contains an invalid character`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sendIfAvailable(sender: Electron.WebContents, channel: string, payload: unknown): void {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

// Denoise jobs are queued in one service rather than per request, so their events
// go to the window rather than back to whichever `invoke` started them.
function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) sendIfAvailable(mainWindow.webContents, channel, payload)
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
  // Loading the model takes about a second; doing it now means the first job does not.
  denoiser.warmUp()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  converter.cancelAll()
  denoiser.dispose()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
