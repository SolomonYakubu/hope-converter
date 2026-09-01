/**
 * The denoise worker. One of these serves exactly one request — one file, or one
 * A/B preview — and is then terminated by the service that started it.
 *
 * That is not tidiness. The model states carry recurrent history and cannot be
 * cleared (see `engine.ts` for the measurement), so reusing a thread would render
 * the second file in a queue differently from the way a fresh run renders it. A
 * fresh thread is the only way to get a fresh wasm instance: the vendored glue
 * holds a single module-level instance, and `initAsync` returns the existing one
 * on a second call.
 *
 * The model is loaded as soon as the thread starts rather than when the request
 * arrives, so the service can keep one loaded worker standing by and the wait is
 * spent while the previous file is still being processed.
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { messageOf } from '../utils/guards'
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
 * Loading starts immediately rather than when the request arrives, so the model is
 * warm by the time the service hands this thread its work. A failure here is
 * reported once, and re-thrown to the request if one arrives anyway, which is what
 * makes the feature degrade to "disabled" rather than break the app.
 */
const ready = (async (): Promise<DeepFilterBank> => {
  const assets = await loadAssets(settings.assetDirectory)
  return await DeepFilterBank.create(assets.wasm, assets.model, settings.options)
})()

void ready.then(
  (bank) => post({ type: 'ready', frameLength: bank.frameLength }),
  (cause) => post({ type: 'unavailable', reason: messageOf(cause) })
)

let controller: AbortController | null = null
let servingId: string | null = null
/** A cancel that arrived before the request it names, which the service can send. */
let cancelledEarly: string | null = null

port.on('message', (message: DenoiseWorkerRequest) => {
  if (message.type === 'cancel') {
    cancel(message.id)
    return
  }
  void handle(message)
})

/** Aborts the request this thread is serving, or remembers a cancel that beat it. */
function cancel(id: string): void {
  if (id === servingId) {
    controller?.abort()
    return
  }
  cancelledEarly = id
}

async function handle(message: DenoiseJobMessage | DenoisePreviewMessage): Promise<void> {
  const { id } = message.request
  if (servingId !== null) {
    // The service starts a thread per request; a second one here would run on a
    // used model state, which is the thing this design exists to prevent.
    post({ type: 'failed', id, message: 'This denoise worker has already served a request' })
    return
  }
  servingId = id

  const abortController = new AbortController()
  controller = abortController
  if (cancelledEarly === id) abortController.abort()

  try {
    if (abortController.signal.aborted) throw new DenoiseCancelledError(id)
    const bank = await ready
    bank.prepare(message.channels, message.request.options)
    if (message.type === 'job') await runJob(bank, message, abortController.signal)
    else await runPreview(bank, message, abortController.signal)
  } catch (cause) {
    // An abort is the user's decision, not a failure to report as one.
    if (abortController.signal.aborted || cause instanceof DenoiseCancelledError) {
      post({ type: 'cancelled', id })
    } else {
      post({ type: 'failed', id, message: messageOf(cause) })
    }
  } finally {
    controller = null
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
 * model — as short WAVs the renderer decodes for its A/B player.
 *
 * The cleaned half carries the speech lift, which is a within-file correction and so
 * means the same thing on an excerpt as on the whole recording. It deliberately does
 * *not* carry loudness normalizing: `loudnorm` sets integrated loudness, so on eight
 * seconds it would land those eight seconds on the target rather than showing where
 * the finished file lands — and it would leave the cleaned half the louder of the two,
 * which decides an A/B comparison before anyone has listened to it. The caption in the
 * panel says as much rather than letting the clips imply otherwise.
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
      normalizeLoudness: false,
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
