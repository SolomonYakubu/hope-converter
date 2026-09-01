import { FileAudio, FileImage, FileVideo } from 'lucide-react'
import type { MediaKind } from '../../electron/types/conversion'

/** The single glyph used for a media kind, shared by both workspace views. */
export function KindIcon({ kind, size = 18 }: { kind: MediaKind; size?: number }) {
  if (kind === 'video') return <FileVideo size={size} />
  if (kind === 'audio') return <FileAudio size={size} />
  return <FileImage size={size} />
}
