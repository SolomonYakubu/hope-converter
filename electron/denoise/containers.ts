/**
 * Which container a denoised video is written to, and what that container can
 * legally carry.
 *
 * Kept free of Node imports so the renderer can consult the same table the
 * command builder does: the panel has to tell someone, before the job runs, which
 * of their file's streams will not survive the remux, and a second copy of this
 * knowledge in the UI would be a second chance to be wrong about it.
 */

export interface VideoContainer {
  /** Extension the denoised copy is written with — not always the input's own. */
  extension: string
  /** Audio codec the soundtrack is re-encoded to, chosen for what the container accepts. */
  codec: string
  /**
   * Set only for containers that hold any codec at all. Those carry the original's
   * other audio tracks, subtitles and attachments across; the rest take the video,
   * chapters and metadata only, because copying an image-based subtitle into MP4 or
   * an AC-3 track into WebM fails the whole remux, and losing the job is worse than
   * losing the stream.
   */
  carriesAnything?: true
}

/**
 * The video stream is always copied, never re-encoded, so the audio codec has to
 * be one the container accepts.
 *
 * Containers that mux modern audio poorly (AVI, FLV, WMV) are written to Matroska
 * instead — still a straight copy of the original picture, just in a wrapper that
 * takes AAC without complaint.
 */
const VIDEO_CONTAINERS: Record<string, VideoContainer> = {
  mp4: { extension: 'mp4', codec: 'aac' },
  m4v: { extension: 'm4v', codec: 'aac' },
  mov: { extension: 'mov', codec: 'aac' },
  mkv: { extension: 'mkv', codec: 'aac', carriesAnything: true },
  webm: { extension: 'webm', codec: 'libopus' },
  avi: { extension: 'mkv', codec: 'aac', carriesAnything: true },
  flv: { extension: 'mkv', codec: 'aac', carriesAnything: true },
  wmv: { extension: 'mkv', codec: 'aac', carriesAnything: true }
}

/** The container a video with this extension is rebuilt as, or null if unsupported. */
export function videoContainerForExtension(extension: string): VideoContainer | null {
  return VIDEO_CONTAINERS[extension.replace(/^\./, '').toLowerCase()] ?? null
}
