/**
 * The denoise worker. One of these is started when the app becomes ready and
 * lives for the process: the model costs ~28 MB of wasm heap to load and has no
 * usable destructor (see `engine.ts`), so it is created once and reused.
 *
 * Jobs run one at a time. The heavy work is FFmpeg's and the model's, both of
 * which saturate a core on their own, and running two at once would only make
 * each slower while multiplying the wasm heap.
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { loadAssets } from './assets'
import { buildPreviewExtractArgs } from './command-builder'
import { DeepFilterBank } from './engine'
import { DenoiseCancelledError } from './errors'
import { runDenoisePipeline, runFFmpeg } from './pipeline'
import type {
  DenoiseJobMessage,
  DenoisePreviewMessage,
  DenoiseWorkerData,
  DenoiseWorkerEvent,
  DenoiseWorkerRequest
} from './protocol'

const port = requirePort()
const settings = workerData as DenoiseWorkerData

function requirePort(): MessagePort {
  if (!parentPort) throw new Error('The denoise worker can only run as a worker thread')
  return parentPort
}

/**
 * Loading starts immediately rather than on the first job, so the model is warm
 * by the time anyone asks. A failure here is reported once and then re-thrown to
 * every job that arrives, which is what makes the feature degrade to "disabled"
 * rather than break the app.
 */
const ready = (async (): Promise<DeepFilterBank> => {
  const assets = await loadAssets(settings.assetDirectory)
  return await DeepFilterBank.create(assets.wasm, assets.model, settings.options)
})()

void ready.then(
  (bank) => post({ type: 'ready', frameLength: bank.frameLength }),
  (cause) => post({ type: 'unavailable', reason: describe(cause) })
)

const queue: Array<DenoiseJobMessage | DenoisePreviewMessage> = []
let controller: AbortController | null = null
let activeId: string | null = null
let draining = false

port.on('message', (message: DenoiseWorkerRequest) => {
  if (message.type === 'cancel') {
    cancel(message.id)
    return
  }
  queue.push(message)
  void drain()
})

/** Aborts the running job, or drops a queued one that never started. */
function cancel(id: string): void {
  if (id === activeId) {
    controller?.abort()
    return
  }
  const index = queue.findIndex((message) => message.request.id === id)
  if (index < 0) return
  queue.splice(index, 1)
  post({ type: 'cancelled', id })
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    let message = queue.shift()
    while (message) {
      await handle(message)
      message = queue.shift()
    }
  } finally {
    draining = false
  }
}

async function handle(message: DenoiseJobMessage | DenoisePreviewMessage): Promise<void> {
  const { id } = message.request
  const abortController = new AbortController()
  controller = abortController
  activeId = id

  try {
    const bank = await ready
    bank.prepare(message.channels, message.request.options)
    if (message.type === 'job') await runJob(bank, message, abortController.signal)
    else await runPreview(bank, message, abortController.signal)
  } catch (cause) {
    // An abort is the user's decision, not a failure to report as one.
    if (abortController.signal.aborted || cause instanceof DenoiseCancelledError) {
      post({ type: 'cancelled', id })
    } else {
      post({ type: 'failed', id, message: describe(cause) })
    }
  } finally {
    controller = null
    activeId = null
  }
}

async function runJob(bank: DeepFilterBank, message: DenoiseJobMessage, signal: AbortSignal): Promise<void> {
  const { request } = message
  await runDenoisePipeline({
    id: request.id,
    inputPath: request.inputPath,
    outputPath: request.outputPath,
    kind: request.kind,
    channels: message.channels,
    bank,
    ffmpegPath: settings.ffmpegPath,
    totalSeconds: request.durationSeconds,
    audioFormat: request.audioFormat,
    audioBitrateKbps: request.audioBitrateKbps,
    speechGainDb: request.options.speechGainDb,
    normalizeLoudness: request.options.normalizeLoudness,
    signal,
    onProgress: (progress) => post({ type: 'progress', progress })
  })
  post({ type: 'done', result: { id: request.id, outputPath: request.outputPath } })
}

/**
 * Renders the same window twice — once straight from the source, once through the
 * model and the level stage — as short WAVs the renderer decodes for its A/B
 * player. The cleaned half deliberately carries the level settings too: a preview
 * that skipped them would not be the file the person is about to write.
 *
 * Both are handed over as transferred ArrayBuffers so the bytes are moved rather
 * than copied, and the scratch directory never outlives the request.
 */
async function runPreview(
  bank: DeepFilterBank,
  message: DenoisePreviewMessage,
  signal: AbortSignal
): Promise<void> {
  const { request } = message
  const directory = await mkdtemp(join(tmpdir(), 'hope-denoise-'))
  const originalPath = join(directory, 'original.wav')
  const denoisedPath = join(directory, 'denoised.wav')

  try {
    await runFFmpeg(settings.ffmpegPath, buildPreviewExtractArgs({
      inputPath: request.inputPath,
      channels: message.channels,
      startSeconds: request.startSeconds,
      durationSeconds: request.durationSeconds,
      outputPath: originalPath
    }))
    if (signal.aborted) throw new DenoiseCancelledError(request.id)

    await runDenoisePipeline({
      id: request.id,
      inputPath: request.inputPath,
      outputPath: denoisedPath,
      kind: 'audio',
      audioFormat: 'wav',
      channels: message.channels,
      bank,
      ffmpegPath: settings.ffmpegPath,
      startSeconds: request.startSeconds,
      limitSeconds: request.durationSeconds,
      totalSeconds: request.durationSeconds,
      speechGainDb: request.options.speechGainDb,
      normalizeLoudness: request.options.normalizeLoudness,
      signal
    })

    const [original, denoised] = await Promise.all([readBytes(originalPath), readBytes(denoisedPath)])
    port.postMessage(
      { type: 'preview', result: { id: request.id, original, denoised } } satisfies DenoiseWorkerEvent,
      [original, denoised]
    )
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Detaches the bytes from Node's read pool so they can be transferred. */
async function readBytes(path: string): Promise<ArrayBuffer> {
  const buffer = await readFile(path)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

function post(event: DenoiseWorkerEvent): void {
  port.postMessage(event)
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
