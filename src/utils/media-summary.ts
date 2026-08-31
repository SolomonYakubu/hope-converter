import type { MediaKind, MediaMetadata } from '../../electron/types/conversion'

/** Formats a media duration as `m:ss`, or `h:mm:ss` for hour-long media. */
export function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null

  const total = Math.round(seconds)
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const remainder = total % 60
  const paddedSeconds = String(remainder).padStart(2, '0')

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`
}

/** Builds the short metadata chips shown beneath a queued file. */
export function describeMetadata(kind: MediaKind, metadata: MediaMetadata): string[] {
  const chips: string[] = []
  const dimensions = metadata.width && metadata.height ? `${metadata.width}×${metadata.height}` : null

  // Still images report a nominal single-frame duration that means nothing to a user.
  if (kind !== 'image') {
    const duration = metadata.duration === undefined ? null : formatDuration(metadata.duration)
    if (duration) chips.push(duration)
  }

  if (kind === 'audio') {
    if (metadata.audioCodec) chips.push(metadata.audioCodec)
    if (metadata.audioSampleRate) chips.push(`${Math.round(metadata.audioSampleRate / 1_000)} kHz`)
    if (metadata.audioChannels) chips.push(metadata.audioChannels === 1 ? 'Mono' : 'Stereo')
    return chips
  }

  if (dimensions) chips.push(dimensions)
  if (metadata.videoCodec) chips.push(metadata.videoCodec)
  if (kind === 'video' && metadata.fps) chips.push(`${Math.round(metadata.fps)} fps`)

  return chips
}
