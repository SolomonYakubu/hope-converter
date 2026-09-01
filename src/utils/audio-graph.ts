/**
 * The WebAudio plumbing behind the A/B player.
 *
 * Both versions of a clip play at once through their own gain, and switching is a
 * short crossfade between them rather than a stop and a start. That is what makes
 * the comparison instant: the audio never restarts, so the ear hears the same
 * moment twice instead of hunting for it.
 *
 * Everything here needs a live audio device, so it is deliberately separate from
 * the sample maths in `waveform.ts`, which is pure and tested.
 */

/** Scheduled a hair ahead so both sources begin on exactly the same sample. */
const START_LEAD_SECONDS = 0.02

let shared: AudioContext | null = null

/**
 * The one context for the whole renderer. Browsers allow only a handful, and
 * decoding uses this too, so a per-preview context would run the app out of them.
 */
export function getAudioContext(): AudioContext {
  shared ??= new AudioContext()
  return shared
}

/** Decodes WAV bytes from the worker. The buffer is detached in the process. */
export async function decodeAudio(bytes: ArrayBuffer): Promise<AudioBuffer> {
  return await getAudioContext().decodeAudioData(bytes)
}

export interface AbGraphHandle {
  /** Called when the clip reaches its end, which only happens with looping off. */
  onEnded: (() => void) | null
  start: (offset: number) => void
  setGains: (original: number, cleaned: number, fadeSeconds: number) => void
  setLoop: (loop: boolean) => void
  /** Seconds into the clip, before any wrap for looping. */
  elapsed: () => number
  dispose: () => void
}

export function createAbGraph(
  context: AudioContext,
  original: AudioBuffer,
  cleaned: AudioBuffer,
  loop: boolean
): AbGraphHandle {
  const originalGain = context.createGain()
  const cleanedGain = context.createGain()
  originalGain.gain.value = 0
  cleanedGain.gain.value = 0
  originalGain.connect(context.destination)
  cleanedGain.connect(context.destination)

  const sources = [
    createSource(context, original, originalGain, loop),
    createSource(context, cleaned, cleanedGain, loop)
  ]

  let startedAt = 0
  let offset = 0
  let disposed = false
  let finished = false

  const handle: AbGraphHandle = {
    onEnded: null,

    start: (from) => {
      offset = from
      // Both sources take the same future timestamp rather than "now", so no
      // scheduling jitter between the two calls can knock them out of alignment.
      startedAt = context.currentTime + START_LEAD_SECONDS
      for (const source of sources) source.start(startedAt, from)
    },

    setGains: (originalLevel, cleanedLevel, fadeSeconds) => {
      ramp(context, originalGain.gain, originalLevel, fadeSeconds)
      ramp(context, cleanedGain.gain, cleanedLevel, fadeSeconds)
    },

    setLoop: (next) => {
      for (const source of sources) source.loop = next
    },

    elapsed: () => Math.max(0, context.currentTime - startedAt) + offset,

    dispose: () => {
      disposed = true
      for (const source of sources) {
        source.onended = null
        // Throws if it never started, which is not worth distinguishing here.
        try { source.stop() } catch { /* not started */ }
        source.disconnect()
      }
      originalGain.disconnect()
      cleanedGain.disconnect()
    }
  }

  for (const source of sources) {
    source.onended = () => {
      // Two sources end together, and a dispose ends them both deliberately.
      if (disposed || finished) return
      finished = true
      handle.onEnded?.()
    }
  }

  return handle
}

function createSource(
  context: AudioContext,
  buffer: AudioBuffer,
  destination: GainNode,
  loop: boolean
): AudioBufferSourceNode {
  const source = context.createBufferSource()
  source.buffer = buffer
  source.loop = loop
  source.connect(destination)
  return source
}

/** Ramps from wherever the parameter is now, so a switch mid-fade stays smooth. */
function ramp(context: AudioContext, param: AudioParam, value: number, fadeSeconds: number): void {
  const now = context.currentTime
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  if (fadeSeconds > 0) param.linearRampToValueAtTime(value, now + fadeSeconds)
  else param.setValueAtTime(value, now)
}
