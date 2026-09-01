/**
 * Where a converted file is written, and under what name.
 *
 * Which files the app will open in the first place is `media-kind.ts`, which is kept
 * free of Node imports so the renderer can share it. This half cannot be: naming an
 * output is path work, and path work belongs to the process that owns the disk.
 */
import { join, parse } from 'node:path'

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
