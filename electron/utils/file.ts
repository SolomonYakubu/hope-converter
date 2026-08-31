import { extname, join, parse } from 'node:path'
import type { MediaKind } from '../types/conversion'

const SUPPORTED_EXTENSIONS: Record<MediaKind, ReadonlySet<string>> = {
  video: new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv']),
  audio: new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma']),
  image: new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'tif', 'tiff', 'bmp', 'gif'])
}

export function classifyMedia(filePath: string): MediaKind | null {
  const extension = extname(filePath).slice(1).toLowerCase()
  if (!extension) return null

  for (const [kind, extensions] of Object.entries(SUPPORTED_EXTENSIONS) as [MediaKind, ReadonlySet<string>][]) {
    if (extensions.has(extension)) return kind
  }

  return null
}

export function isSupportedInput(filePath: string): boolean {
  return classifyMedia(filePath) !== null
}

export function createOutputPath(
  inputPath: string,
  outputDirectory: string,
  outputExtension: string,
  customName?: string
): string {
  const extension = outputExtension.replace(/^\./, '').toLowerCase()
  if (!/^[a-z0-9]+$/.test(extension)) throw new Error('Invalid output extension')

  const defaultName = `${parse(inputPath).name}-converted`
  const safeName = sanitizeFilename(customName?.trim() || defaultName)
  return join(outputDirectory, `${safeName}.${extension}`)
}

function sanitizeFilename(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/[. ]+$/g, '')

  if (!sanitized) throw new Error('Output filename cannot be empty')
  return sanitized
}
