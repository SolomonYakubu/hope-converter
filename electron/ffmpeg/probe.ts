import { spawn } from 'node:child_process'
import ffprobeStatic from 'ffprobe-static'
import type { MediaMetadata } from '../types/conversion'
import { unpackedBinaryPath } from './binary-path'

export type Spawn = typeof spawn
export type { MediaMetadata }

export interface ProbeDependencies {
  spawn?: Spawn
  ffprobePath?: string
}

interface FFprobeStream {
  codec_type?: unknown
  codec_name?: unknown
  width?: unknown
  height?: unknown
  avg_frame_rate?: unknown
  r_frame_rate?: unknown
  sample_rate?: unknown
  channels?: unknown
}

interface FFprobeOutput {
  format?: {
    duration?: unknown
    format_name?: unknown
  }
  streams?: unknown
}

export async function probeMedia(
  inputPath: string,
  dependencies: ProbeDependencies = {}
): Promise<MediaMetadata> {
  assertPath(inputPath)

  const output = await runFFprobe(inputPath, dependencies)
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('ffprobe did not return valid JSON')
  }
  if (!isRecord(parsed)) throw new Error('ffprobe did not return valid JSON')

  const data = parsed as FFprobeOutput
  const streams = Array.isArray(data.streams) ? data.streams.filter(isRecord) as FFprobeStream[] : []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const metadata: MediaMetadata = {}

  assignString(metadata, 'container', data.format?.format_name)
  // ffprobe reports format duration and stream sample rates as strings, but
  // integer stream properties as JSON numbers. Anything else is malformed.
  assignPositiveNumeric(metadata, 'duration', data.format?.duration)
  assignString(metadata, 'videoCodec', video?.codec_name)
  assignString(metadata, 'audioCodec', audio?.codec_name)
  assignPositiveNumber(metadata, 'width', video?.width)
  assignPositiveNumber(metadata, 'height', video?.height)
  const fps = parseFraction(video?.avg_frame_rate) ?? parseFraction(video?.r_frame_rate)
  if (fps !== undefined) metadata.fps = fps
  assignPositiveNumeric(metadata, 'audioSampleRate', audio?.sample_rate)
  assignPositiveNumber(metadata, 'audioChannels', audio?.channels)

  return metadata
}

export async function probeDuration(
  inputPath: string,
  dependencies: ProbeDependencies = {}
): Promise<number> {
  const duration = (await probeMedia(inputPath, dependencies)).duration
  if (duration === undefined) throw new Error('ffprobe did not return a valid media duration')
  return duration
}

async function runFFprobe(inputPath: string, dependencies: ProbeDependencies): Promise<string> {
  const spawnProcess = dependencies.spawn ?? spawn
  const ffprobePath = unpackedBinaryPath(dependencies.ffprobePath ?? ffprobeStatic.path)

  return await new Promise<string>((resolve, reject) => {
    let child
    try {
      child = spawnProcess(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels',
        '-of', 'json',
        inputPath
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (cause) {
      reject(cause)
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${String(code)}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
        return
      }
      resolve(stdout)
    })
  })
}

function parseFraction(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value.trim().split('/')
  if (parts.length !== 2) return undefined
  const numerator = Number(parts[0])
  const denominator = Number(parts[1])
  const result = numerator / denominator
  return Number.isFinite(result) && result > 0 ? result : undefined
}

function assignString<K extends keyof MediaMetadata>(
  target: MediaMetadata,
  key: K,
  value: unknown
): void {
  if (typeof value === 'string' && value.trim()) target[key] = value as never
}

function assignPositiveNumber<K extends keyof MediaMetadata>(
  target: MediaMetadata,
  key: K,
  value: unknown
): void {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) target[key] = value as never
}

function assignPositiveNumeric<K extends keyof MediaMetadata>(
  target: MediaMetadata,
  key: K,
  value: unknown
): void {
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (value.trim() && Number.isFinite(parsed) && parsed > 0) target[key] = parsed as never
    return
  }
  assignPositiveNumber(target, key, value)
}

function assertPath(value: string): void {
  if (!value.trim()) throw new Error('input path cannot be empty')
  if (value.includes('\u0000')) throw new Error('input path contains an invalid character')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
