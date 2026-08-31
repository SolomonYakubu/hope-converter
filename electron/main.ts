import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFFmpegArgs } from './ffmpeg/command-builder'
import { ConverterService } from './ffmpeg/converter'
import { detectHardwareEncoders, getFFmpegVersion } from './ffmpeg/hardware'
import { probeMedia } from './ffmpeg/probe'
import type { ConversionRequest } from './types/conversion'
import { IPC_CHANNELS } from './types/ipc'
import { classifyMedia, isSupportedInput } from './utils/file'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const converter = new ConverterService()
let mainWindow: BrowserWindow | null = null

// Packaged builds take their icon from electron-builder, but the source PNG
// still dresses the window and taskbar while developing on Windows and Linux.
function resolveWindowIcon(): string | undefined {
  const iconPath = join(currentDirectory, '../../resources/icon.png')
  return existsSync(iconPath) ? iconPath : undefined
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0c0d0e',
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: join(currentDirectory, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
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

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => converter.cancelAll())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
