import { describe, expect, it } from 'vitest'
import { DENOISE_DEFAULTS, DENOISE_LIFT_SPEECH_DB, createDenoiseStore, denoiseOptionsFrom, levelModeFor } from '../../src/stores/denoise-store'
import {
  DENOISE_MAX_ATTENUATION_DB,
  DENOISE_MAX_SPEECH_GAIN_DB,
  DENOISE_POST_FILTER_BETA,
  originalShareForLimitDb
} from '../../electron/types/denoise'
import type { MediaMetadata } from '../../electron/types/conversion'
import type { InputFile } from '../../src/types/hope-converter'

const interview: InputFile = { path: '/media/interview.mov', name: 'interview.mov', size: 8_388_608, kind: 'video' }
const memo: InputFile = { path: '/media/memo.m4a', name: 'memo.m4a', size: 524_288, kind: 'audio' }
const cover: InputFile = { path: '/media/cover.png', name: 'cover.png', size: 4_096, kind: 'image' }

const spoken: MediaMetadata = { audioCodec: 'aac', audioChannels: 2, duration: 61.5 }
const silent: MediaMetadata = { duration: 12 }

function seed(files: InputFile[] = [memo]) {
  const store = createDenoiseStore()
  store.getState().addFiles(files)
  return { store, id: store.getState().items[0]?.id ?? '' }
}

describe('denoise store', () => {
  it('starts at the last setting that keeps a quarter of the original recording', () => {
    expect(createDenoiseStore().getState()).toMatchObject(DENOISE_DEFAULTS)
    // The limit is a dry/wet mix, so the default is chosen by what it keeps: a
    // quarter of the original, which is what carries a quiet word-ending the model
    // did not hold as speech.
    expect(DENOISE_DEFAULTS.strength).toBe(12)
    expect(originalShareForLimitDb(DENOISE_DEFAULTS.strength)).toBeCloseTo(0.25, 2)
  })

  it('adds audio and video once each, and never an image or a pathless file', () => {
    const { store } = seed([memo, memo, interview, cover, { ...memo, path: '', name: 'dropped.m4a' }])

    expect(store.getState().items.map((item) => item.name)).toEqual(['memo.m4a', 'interview.mov'])
    expect(store.getState().items[0]).toMatchObject({ ...memo, status: 'queued', progress: 0, speed: null })
    expect(store.getState().items.map((item) => item.id)).toEqual([...new Set(store.getState().items.map((item) => item.id))])
  })

  it('clamps the strength to the offered range and keeps it whole', () => {
    const { store } = seed()
    // The engine accepts up to 100, but past 24 dB the dial only removes quiet
    // speech, so the control does not go there.
    store.getState().setStrength(60)
    expect(store.getState().strength).toBe(DENOISE_MAX_ATTENUATION_DB)
    store.getState().setStrength(-5)
    expect(store.getState().strength).toBe(0)
    store.getState().setStrength(14.6)
    expect(store.getState().strength).toBe(15)
  })

  it('clamps the speech lift to what the encoder will accept, and keeps it whole', () => {
    const { store } = seed()
    store.getState().setSpeechGainDb(40)
    expect(store.getState().speechGainDb).toBe(DENOISE_MAX_SPEECH_GAIN_DB)
    store.getState().setSpeechGainDb(-6)
    expect(store.getState().speechGainDb).toBe(0)
    store.getState().setSpeechGainDb(7.4)
    expect(store.getState().speechGainDb).toBe(7)
  })

  it('carries the other settings through untouched', () => {
    const { store } = seed()
    store.getState().setPostFilter(false)
    store.getState().setAudioFormat('mp3')
    store.getState().setNormalizeLoudness(true)
    expect(store.getState()).toMatchObject({ postFilter: false, audioFormat: 'mp3', normalizeLoudness: true })
  })

  it('sets both level stages from the three-way control, and reads them back', () => {
    const { store } = seed()
    expect(levelModeFor(store.getState())).toBe('as-recorded')

    store.getState().setLevelMode('lift-speech')
    expect(store.getState()).toMatchObject({ speechGainDb: DENOISE_LIFT_SPEECH_DB, normalizeLoudness: false })
    expect(levelModeFor(store.getState())).toBe('lift-speech')

    // Switching to the absolute target keeps the lift, which still shapes what
    // reaches it; the mode reads as the target because the target lands the file.
    store.getState().setLevelMode('match-loudness')
    expect(store.getState()).toMatchObject({ speechGainDb: DENOISE_LIFT_SPEECH_DB, normalizeLoudness: true })
    expect(levelModeFor(store.getState())).toBe('match-loudness')

    store.getState().setLevelMode('as-recorded')
    expect(store.getState()).toMatchObject({ speechGainDb: 0, normalizeLoudness: false })
    expect(levelModeFor(store.getState())).toBe('as-recorded')
  })

  it('leaves a lift set by hand alone when the mode it implies is picked', () => {
    const { store } = seed()
    store.getState().setSpeechGainDb(15)
    store.getState().setLevelMode('lift-speech')
    expect(store.getState().speechGainDb).toBe(15)
  })

  it('clamps progress and marks a reporting file as processing', () => {
    const { store, id } = seed()
    store.getState().updateProgress({ id, percent: 140, processedSeconds: 90, speed: 3.25 })

    expect(store.getState().items[0]).toMatchObject({ status: 'processing', progress: 100, speed: 3.25 })
    store.getState().updateProgress({ id, percent: -1, processedSeconds: 0, speed: null })
    expect(store.getState().items[0]).toMatchObject({ progress: 0, speed: null })
  })

  it('keeps an unmeasurable percentage null rather than reporting a confident zero', () => {
    // A file whose duration ffprobe could not read: the work is real and the clock
    // moves, so rounding the unknown down to 0% would have the row claim a
    // measurement it does not have for the whole run.
    const { store, id } = seed()
    store.getState().updateProgress({ id, percent: null, processedSeconds: 42, speed: 1.75 })

    expect(store.getState().items[0]).toMatchObject({
      status: 'processing', progress: null, processedSeconds: 42, speed: 1.75
    })
  })

  it('ignores progress for a file that is no longer queued', () => {
    const { store } = seed()
    store.getState().updateProgress({ id: 'gone', percent: 50, processedSeconds: 1, speed: 1 })
    expect(store.getState().items[0]).toMatchObject({ status: 'queued', progress: 0 })
  })

  it('completes a file with its output path and drops any earlier error', () => {
    const { store, id } = seed()
    store.getState().setStatus(id, 'error', 'FFmpeg gave up')
    store.getState().completeItem(id, '/exports/memo-denoised.flac')

    expect(store.getState().items[0]).toMatchObject({
      status: 'completed', progress: 100, speed: null, error: undefined, outputPath: '/exports/memo-denoised.flac'
    })
  })

  it('resets progress when a file goes back to the queue but keeps what it reached when it stops', () => {
    const { store, id } = seed()
    store.getState().updateProgress({ id, percent: 55, processedSeconds: 30, speed: 2 })

    store.getState().setStatus(id, 'cancelled')
    expect(store.getState().items[0]).toMatchObject({ status: 'cancelled', progress: 55, speed: null })

    store.getState().setStatus(id, 'queued')
    expect(store.getState().items[0]).toMatchObject({ status: 'queued', progress: 0, error: undefined })
  })

  it('records a probe so the panel can tell a silent file from a spoken one', () => {
    const { store, id } = seed()
    store.getState().setMetadata(id, spoken)
    expect(store.getState().items[0]?.metadata).toEqual(spoken)

    store.getState().setMetadata(id, silent)
    expect(store.getState().items[0]?.metadata?.audioCodec).toBeUndefined()
  })

  it('removes one file and clears every finished one, leaving work in flight alone', () => {
    const store = createDenoiseStore()
    store.getState().addFiles([memo, interview, { ...memo, path: '/media/third.wav', name: 'third.wav' }])
    const [first, second, third] = store.getState().items.map((item) => item.id)

    store.getState().completeItem(first as string, '/exports/memo-denoised.flac')
    store.getState().setStatus(second as string, 'error', 'No audio track')
    store.getState().updateProgress({ id: third as string, percent: 10, processedSeconds: 2, speed: 1 })

    store.getState().clearFinished()
    expect(store.getState().items.map((item) => item.name)).toEqual(['third.wav'])

    store.getState().removeItem(third as string)
    expect(store.getState().items).toEqual([])
  })

  it('queues a cleaned file again instead of dropping the pick as a duplicate', () => {
    const { store, id } = seed()
    store.getState().setMetadata(id, spoken)
    store.getState().completeItem(id, '/exports/memo-denoised.flac')

    const outcome = store.getState().addFiles([memo])

    expect(outcome).toEqual({ added: 0, requeued: 1, alreadyQueued: 0 })
    expect(store.getState().items).toHaveLength(1)
    expect(store.getState().items[0]).toMatchObject({ id, status: 'queued', progress: 0, speed: null })
    expect(store.getState().items[0]?.outputPath).toBeUndefined()
    // The probe result still describes the same file, and nothing re-probes a
    // revived row, so losing it would leave the row without its details forever.
    expect(store.getState().items[0]?.metadata).toEqual(spoken)
  })

  it('leaves a file that is queued or being cleaned exactly as it is', () => {
    const { store, id } = seed()
    store.getState().updateProgress({ id, percent: 40, processedSeconds: 4, speed: 2 })
    const before = store.getState().items

    expect(store.getState().addFiles([memo])).toEqual({ added: 0, requeued: 0, alreadyQueued: 1 })
    // Identity, not just equality: an unchanged queue must not re-render.
    expect(store.getState().items).toBe(before)
  })

  it('counts an image as neither added nor blocked, since it never belonged here', () => {
    const { store } = seed()
    expect(store.getState().addFiles([cover])).toEqual({ added: 0, requeued: 0, alreadyQueued: 0 })
  })
})

describe('denoiseOptionsFrom', () => {
  it('turns the panel state into the engine settings, constant and all', () => {
    // The panel used to spell 0.02 out itself, in a second place that could drift
    // from the engine's own default. The switch means this constant and nothing else.
    expect(denoiseOptionsFrom({ ...DENOISE_DEFAULTS, postFilter: true })).toEqual({
      attenuationLimitDb: DENOISE_DEFAULTS.strength,
      postFilterBeta: DENOISE_POST_FILTER_BETA,
      speechGainDb: 0,
      normalizeLoudness: false
    })
  })

  it('sends no post-filter at all when the switch is off', () => {
    expect(denoiseOptionsFrom({ ...DENOISE_DEFAULTS, postFilter: false }).postFilterBeta).toBe(0)
  })

  it('carries the level settings through untouched, for the engine to validate', () => {
    // Deliberately not clamped here: the builder rejects a value out of range, and
    // silently correcting one would hide a slider that had gone wrong.
    expect(denoiseOptionsFrom({
      ...DENOISE_DEFAULTS,
      strength: DENOISE_MAX_ATTENUATION_DB,
      speechGainDb: DENOISE_MAX_SPEECH_GAIN_DB,
      normalizeLoudness: true
    })).toMatchObject({
      attenuationLimitDb: DENOISE_MAX_ATTENUATION_DB,
      speechGainDb: DENOISE_MAX_SPEECH_GAIN_DB,
      normalizeLoudness: true
    })
  })

  it('reads only the settings, so the queue cannot change what the model is given', () => {
    // It takes DenoiseSettings rather than the whole store state: the same panel
    // settings must mean the same engine options for every row in the queue.
    const { store } = seed()
    store.getState().setStrength(18)
    const state = store.getState()

    expect(denoiseOptionsFrom(state)).toEqual(denoiseOptionsFrom({
      strength: 18,
      postFilter: state.postFilter,
      speechGainDb: state.speechGainDb,
      normalizeLoudness: state.normalizeLoudness,
      audioFormat: state.audioFormat
    }))
  })
})
