import { describe, expect, it } from 'vitest'
import {
  buildAudioFilterChain,
  buildDecodeArgs,
  buildEncodeArgs,
  buildPreviewExtractArgs,
  denoisedExtension
} from '../../electron/denoise/command-builder'
import { DENOISE_LOUDNESS_TARGET_LUFS, DENOISE_MAX_SPEECH_GAIN_DB } from '../../electron/types/denoise'

// A name with a space and a semicolon: if anything ever quoted or shelled out,
// these arguments are where it would show.
const input = '/Users/A Person/interview; take 2.mov'
const audioInput = '/Users/A Person/voice memo.m4a'

describe('buildDecodeArgs', () => {
  it('decodes the first audio track to raw 48 kHz floats on stdout', () => {
    expect(buildDecodeArgs({ inputPath: audioInput, channels: 1 })).toEqual([
      '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-i', audioInput,
      '-map', '0:a:0',
      '-vn', '-sn', '-dn',
      '-ac', '1',
      '-ar', '48000',
      '-f', 'f32le', 'pipe:1'
    ])
  })

  it('seeks before the input and limits after it, so the window is cheap and exact', () => {
    const args = buildDecodeArgs({ inputPath: input, channels: 2, startSeconds: 12.5, durationSeconds: 8 })
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('-i'))
    expect(args).toEqual(expect.arrayContaining(['-ss', '12.500', '-t', '8.000', '-ac', '2']))
  })

  it('never passes a value in exponential notation', () => {
    expect(buildDecodeArgs({ inputPath: input, channels: 1, startSeconds: 1e-7, durationSeconds: 2 }))
      .toEqual(expect.arrayContaining(['-ss', '0.000']))
  })

  it('rejects arguments FFmpeg would take badly', () => {
    expect(() => buildDecodeArgs({ inputPath: '  ', channels: 1 })).toThrow(/input path cannot be empty/)
    expect(() => buildDecodeArgs({ inputPath: '/in/clip\u0000.mov', channels: 1 })).toThrow(/invalid character/)
    expect(() => buildDecodeArgs({ inputPath: input, channels: 0 })).toThrow(/channels must be 1 or 2/)
    expect(() => buildDecodeArgs({ inputPath: input, channels: 3 })).toThrow(/channels must be 1 or 2/)
    expect(() => buildDecodeArgs({ inputPath: input, channels: 1, startSeconds: -1 })).toThrow(/non-negative/)
    expect(() => buildDecodeArgs({ inputPath: input, channels: 1, durationSeconds: 0 })).toThrow(/greater than zero/)
  })
})

describe('buildAudioFilterChain', () => {
  it('emits nothing at all when neither control is asking for anything', () => {
    // Not a no-op chain: with no -af the file is byte for byte what it was
    // before the level stage existed.
    expect(buildAudioFilterChain({})).toBeNull()
    expect(buildAudioFilterChain({ speechGainDb: 0, normalizeLoudness: false })).toBeNull()
  })

  it('maps a dB lift onto speechnorm exactly', () => {
    // e is a plain amplitude ratio, so the mapping is 10^(dB/20).
    expect(buildAudioFilterChain({ speechGainDb: 6 })).toBe('speechnorm=e=1.995:p=0.95')
    expect(buildAudioFilterChain({ speechGainDb: 12 })).toBe('speechnorm=e=3.981:p=0.95')
    expect(buildAudioFilterChain({ speechGainDb: DENOISE_MAX_SPEECH_GAIN_DB })).toBe('speechnorm=e=7.943:p=0.95')
  })

  it('normalizes to the loudness target on its own', () => {
    expect(buildAudioFilterChain({ normalizeLoudness: true }))
      .toBe(`loudnorm=I=${DENOISE_LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11`)
  })

  it('lifts before it normalizes, so the absolute target is the last word', () => {
    const chain = buildAudioFilterChain({ speechGainDb: 6, normalizeLoudness: true }) as string
    expect(chain.indexOf('speechnorm')).toBeLessThan(chain.indexOf('loudnorm'))
    expect(chain.split(',')).toHaveLength(2)
  })

  it('refuses a lift beyond what the slider can ask for', () => {
    expect(() => buildAudioFilterChain({ speechGainDb: DENOISE_MAX_SPEECH_GAIN_DB + 1 }))
      .toThrow(new RegExp(`between 0 and ${DENOISE_MAX_SPEECH_GAIN_DB} dB`))
    expect(() => buildAudioFilterChain({ speechGainDb: Number.POSITIVE_INFINITY })).toThrow(/between 0 and/)
    // A negative value is a request for no filter rather than an attenuation.
    expect(buildAudioFilterChain({ speechGainDb: -6 })).toBeNull()
  })
})

describe('buildEncodeArgs', () => {
  it('writes lossless audio without a bitrate flag, at a depth it pins itself', () => {
    const args = buildEncodeArgs({ outputPath: '/out/voice-denoised.flac', channels: 1, kind: 'audio' })
    expect(args).toEqual([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
      // `s32` is FLAC's 24-bit mode. Stated rather than left to FFmpeg's own
      // negotiation from f32le, so the depth cannot change with the binary.
      '-c:a', 'flac', '-sample_fmt', 's32',
      '/out/voice-denoised.flac'
    ])
    expect(args).not.toContain('-b:a')
  })

  it('writes a WAV as 24-bit PCM, which is what makes calling it lossless true', () => {
    expect(buildEncodeArgs({ outputPath: '/out/a.wav', channels: 2, kind: 'audio', audioFormat: 'wav' }))
      .toEqual(expect.arrayContaining(['-c:a', 'pcm_s24le']))
  })

  it('defaults to FLAC when no audio format is given', () => {
    expect(buildEncodeArgs({ outputPath: '/out/a.flac', channels: 1, kind: 'audio' }))
      .toEqual(expect.arrayContaining(['-c:a', 'flac']))
  })

  it('sets a bitrate for the lossy formats only', () => {
    expect(buildEncodeArgs({ outputPath: '/out/a.mp3', channels: 2, kind: 'audio', audioFormat: 'mp3' }))
      .toEqual(expect.arrayContaining(['-c:a', 'libmp3lame', '-b:a', '192k']))
    expect(buildEncodeArgs({ outputPath: '/out/a.m4a', channels: 2, kind: 'audio', audioFormat: 'm4a', audioBitrateKbps: 256 }))
      .toEqual(expect.arrayContaining(['-c:a', 'aac', '-b:a', '256k']))
    expect(buildEncodeArgs({ outputPath: '/out/a.wav', channels: 2, kind: 'audio', audioFormat: 'wav' }))
      .not.toContain('-b:a')
  })

  it('copies the picture, chapters and metadata from the original when remuxing a video', () => {
    const args = buildEncodeArgs({
      outputPath: '/out/interview-denoised.mp4',
      channels: 2,
      kind: 'video',
      originalPath: input
    })

    expect(args).toEqual([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-i', input,
      // The picture comes from the original — every video stream of it, not just the
      // first — and the sound from the model.
      '-map', '1:v', '-map', '0:a:0',
      // Chapters are their own list; `-map_metadata` does not carry them.
      '-map_metadata', '1', '-map_chapters', '1',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '/out/interview-denoised.mp4'
    ])
    // MP4 cannot take arbitrary subtitles or a second audio codec, so nothing is
    // asked of it that would fail the mux. The panel names what that leaves behind.
    expect(args).not.toContain('1:s?')
  })

  it('carries the other audio tracks, subtitles and attachments into Matroska', () => {
    const chain = buildAudioFilterChain({ speechGainDb: 6 })
    const args = buildEncodeArgs({
      outputPath: '/out/film-denoised.mkv',
      channels: 2,
      kind: 'video',
      originalPath: '/in/film.mkv',
      speechGainDb: 6
    })

    expect(args).toEqual([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-i', '/in/film.mkv',
      '-map', '1:v', '-map', '0:a:0',
      // Every remaining audio track except the one the cleaned stream replaces.
      // The `?` keeps a file with nothing extra from failing the mux.
      '-map', '1:a?', '-map', '-1:a:0', '-map', '1:s?', '-map', '1:t?',
      '-map_metadata', '1', '-map_chapters', '1',
      '-c:v', 'copy',
      '-c:s', 'copy', '-c:t', 'copy',
      // The cleaned track is output audio 0 because it was mapped first, so the
      // per-stream forms name it while the carried tracks stay a plain copy.
      // `-c:a copy` must come before `-c:a:0`: FFmpeg takes the last match.
      '-filter:a:0', chain,
      '-c:a', 'copy', '-c:a:0', 'aac', '-b:a:0', '192k',
      '/out/film-denoised.mkv'
    ])
  })

  it('rebuilds a container that cannot mux AAC as Matroska, extra streams and all', () => {
    const args = buildEncodeArgs({
      outputPath: '/out/clip-denoised.mkv', channels: 1, kind: 'video', originalPath: '/in/clip.avi'
    })
    expect(args).toEqual(expect.arrayContaining(['-map', '1:s?', '-c:a', 'copy', '-c:a:0', 'aac']))
  })

  it('picks the audio codec the target container accepts', () => {
    expect(buildEncodeArgs({ outputPath: '/out/clip.webm', channels: 1, kind: 'video', originalPath: '/in/clip.webm' }))
      .toEqual(expect.arrayContaining(['-c:a', 'libopus']))
    expect(buildEncodeArgs({ outputPath: '/out/clip.mkv', channels: 1, kind: 'video', originalPath: '/in/clip.mkv' }))
      .toEqual(expect.arrayContaining(['-c:a', 'aac']))
  })

  it('adds faststart only to the MP4 family', () => {
    for (const extension of ['mp4', 'm4v', 'mov']) {
      expect(buildEncodeArgs({ outputPath: `/out/c.${extension}`, channels: 1, kind: 'video', originalPath: `/in/c.${extension}` }))
        .toEqual(expect.arrayContaining(['-movflags', '+faststart']))
    }
    expect(buildEncodeArgs({ outputPath: '/out/c.mkv', channels: 1, kind: 'video', originalPath: '/in/c.mkv' }))
      .not.toContain('-movflags')
  })

  it('refuses a video without its original, which is the only source of the picture', () => {
    expect(() => buildEncodeArgs({ outputPath: '/out/c.mp4', channels: 1, kind: 'video' }))
      .toThrow(/needs its original file/)
  })

  it('rejects unusable outputs and bitrates', () => {
    expect(() => buildEncodeArgs({ outputPath: '', channels: 1, kind: 'audio' })).toThrow(/output path cannot be empty/)
    expect(() => buildEncodeArgs({ outputPath: '/out/c.ogg', channels: 1, kind: 'video', originalPath: '/in/c.ogg' }))
      .toThrow(/does not support the ogg container/)
    expect(() => buildEncodeArgs({ outputPath: '/out/c', channels: 1, kind: 'video', originalPath: '/in/c' }))
      .toThrow(/does not support the unknown container/)
    expect(() => buildEncodeArgs({
      outputPath: '/out/a.mp3', channels: 1, kind: 'audio', audioFormat: 'mp3', audioBitrateKbps: 16
    })).toThrow(/between 32 and 512/)
    expect(() => buildEncodeArgs({
      outputPath: '/out/a.mp3', channels: 1, kind: 'audio', audioFormat: 'mp3', audioBitrateKbps: 128.5
    })).toThrow(/between 32 and 512/)
  })

  it('rejects an audio format that is not one of the four', () => {
    expect(() => buildEncodeArgs({
      outputPath: '/out/a.ogg', channels: 1, kind: 'audio',
      audioFormat: 'ogg' as never
    })).toThrow(/Invalid audio format: ogg/)
  })

  it('filters the audio in both branches, and only the audio', () => {
    const chain = buildAudioFilterChain({ speechGainDb: 12, normalizeLoudness: true }) as string

    const audio = buildEncodeArgs({
      outputPath: '/out/a.flac', channels: 1, kind: 'audio', speechGainDb: 12, normalizeLoudness: true
    })
    expect(audio).toEqual(expect.arrayContaining(['-af', chain]))
    // The level stage runs before the encoder is told what to write.
    expect(audio.indexOf('-af')).toBeLessThan(audio.indexOf('-c:a'))

    const video = buildEncodeArgs({
      outputPath: '/out/c.mp4', channels: 2, kind: 'video', originalPath: input,
      speechGainDb: 12, normalizeLoudness: true
    })
    expect(video).toEqual(expect.arrayContaining(['-af', chain]))
    // The picture is still copied, so the filter can only be reaching the sound.
    expect(video).toEqual(expect.arrayContaining(['-c:v', 'copy']))
    expect(video.indexOf('-af')).toBeGreaterThan(video.indexOf('copy'))
  })

  it('passes no -af when the level stage is off', () => {
    expect(buildEncodeArgs({ outputPath: '/out/a.flac', channels: 1, kind: 'audio' })).not.toContain('-af')
    expect(buildEncodeArgs({ outputPath: '/out/c.mp4', channels: 1, kind: 'video', originalPath: input }))
      .not.toContain('-af')
  })

  it('rejects a bad level setting before anything is spawned', () => {
    expect(() => buildEncodeArgs({
      outputPath: '/out/a.flac', channels: 1, kind: 'audio', speechGainDb: 90
    })).toThrow(/between 0 and/)
  })
})

describe('buildPreviewExtractArgs', () => {
  it('reads the same window as the model but writes a playable WAV', () => {
    const args = buildPreviewExtractArgs({
      inputPath: input, channels: 2, startSeconds: 0, durationSeconds: 8,
      outputPath: '/tmp/preview-original.wav'
    })

    expect(args).toEqual([
      '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-ss', '0.000',
      '-i', input,
      '-t', '8.000',
      '-map', '0:a:0',
      '-vn', '-sn', '-dn',
      '-ac', '2',
      '-ar', '48000',
      '-c:a', 'pcm_s24le', '/tmp/preview-original.wav'
    ])
    // This is the "before" half of the comparison, so no level stage may touch it.
    expect(args).not.toContain('-af')
  })
})

describe('denoisedExtension', () => {
  it('follows the chosen format for audio, whatever the input was', () => {
    expect(denoisedExtension('/in/voice.m4a', 'audio', 'flac')).toBe('flac')
    expect(denoisedExtension('/in/voice.wav', 'audio', 'mp3')).toBe('mp3')
    expect(denoisedExtension('/in/voice.mp3', 'audio')).toBe('flac')
    expect(() => denoisedExtension('/in/voice.wav', 'audio', 'ogg' as never)).toThrow(/Invalid audio format/)
  })

  it('keeps a video container that can carry the new soundtrack', () => {
    expect(denoisedExtension('/in/clip.MP4', 'video')).toBe('mp4')
    expect(denoisedExtension('/in/clip.mov', 'video')).toBe('mov')
    expect(denoisedExtension('/in/clip.webm', 'video')).toBe('webm')
  })

  it('falls back to Matroska for containers that mux AAC poorly', () => {
    expect(denoisedExtension('/in/clip.avi', 'video')).toBe('mkv')
    expect(denoisedExtension('/in/clip.flv', 'video')).toBe('mkv')
    expect(denoisedExtension('/in/clip.wmv', 'video')).toBe('mkv')
  })

  it('refuses a container it cannot rebuild', () => {
    expect(() => denoisedExtension('/in/clip.mpg', 'video')).toThrow(/does not support the mpg container/)
  })
})
