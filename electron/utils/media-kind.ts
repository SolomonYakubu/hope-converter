/**
 * What counts as a file this app can open, and which of the three kinds it is.
 *
 * Kept free of Node imports so the renderer can classify a dropped file by the same
 * table the main process accepts one by: a second copy of the list in the UI would be
 * a second chance to disagree about what the app opens, and the disagreement would
 * show up as a file that can be dropped but not converted.
 *
 * That is also why `extname` is not used below. The split matches it, including
 * treating a name that is nothing but an extension (`.mp4`) as a hidden file rather
 * than as video, so the renderer and the main process reject the same edge cases.
 */
import type { MediaKind } from '../types/conversion'

const SUPPORTED_EXTENSIONS: Record<MediaKind, ReadonlySet<string>> = {
  video: new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv']),
  audio: new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma']),
  image: new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'tif', 'tiff', 'bmp', 'gif'])
}

/** The kind of media a path or a bare filename names, or null if it is not one. */
export function classifyMedia(pathOrName: string): MediaKind | null {
  const name = pathOrName.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 1) return null

  const extension = name.slice(dot + 1).toLowerCase()
  for (const [kind, extensions] of Object.entries(SUPPORTED_EXTENSIONS) as [MediaKind, ReadonlySet<string>][]) {
    if (extensions.has(extension)) return kind
  }
  return null
}

export function isSupportedInput(pathOrName: string): boolean {
  return classifyMedia(pathOrName) !== null
}
