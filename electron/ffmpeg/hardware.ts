import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import type { HardwareCapabilities, VideoCodec } from '../types/conversion'
import { unpackedBinaryPath } from './binary-path'
import type { Spawn } from './probe'

const HARDWARE_ENCODERS = [
  'h264_videotoolbox',
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv'
] as const satisfies readonly VideoCodec[]

export interface FFmpegInfoDependencies {
  spawn?: Spawn
  ffmpegPath?: string
}

export async function detectHardwareEncoders(
  dependencies: FFmpegInfoDependencies = {}
): Promise<HardwareCapabilities> {
  const output = await runFFmpeg(['-hide_banner', '-encoders'], dependencies)
  const available = new Set(
    output
      .split(/\r?\n/)
      .map((line) => /^\s*V\S{5}\s+([a-zA-Z0-9_]+)/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined)
  )
  const encoders = HARDWARE_ENCODERS.filter((encoder) => available.has(encoder))

  return {
    encoders: [...encoders],
    preferredEncoder: encoders[0] ?? null
  }
}

export async function getFFmpegVersion(
  dependencies: FFmpegInfoDependencies = {}
): Promise<string> {
  const output = await runFFmpeg(['-version'], dependencies)
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) throw new Error('FFmpeg did not report a version')
  return firstLine
}

async function runFFmpeg(args: string[], dependencies: FFmpegInfoDependencies): Promise<string> {
  const binaryPath = dependencies.ffmpegPath ?? ffmpegPath
  if (!binaryPath) throw new Error('The bundled FFmpeg executable is unavailable')
  const executable = unpackedBinaryPath(binaryPath)

  const spawnProcess = dependencies.spawn ?? spawn
  return await new Promise<string>((resolve, reject) => {
    const child = spawnProcess(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      const output = `${stdout}\n${stderr}`.trim()
      if (code === 0) resolve(output)
      else reject(new Error(`FFmpeg exited with code ${String(code)}${output ? `: ${output}` : ''}`))
    })
  })
}
