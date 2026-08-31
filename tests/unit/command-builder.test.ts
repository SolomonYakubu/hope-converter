import { describe, expect, it } from 'vitest'
import { buildFFmpegArgs } from '../../electron/ffmpeg/command-builder'

const input = '/Users/A Person/clip;not-a-command.mov'
const output = '/Users/A Person/clip converted.mp4'

describe('buildFFmpegArgs', () => {
  it('builds a safe web-optimized video command', () => {
    const args = buildFFmpegArgs(input, output, {
      kind: 'video',
      videoCodec: 'libx264',
      crf: 23,
      preset: 'medium',
      audioCodec: 'aac',
      audioBitrateKbps: 128,
      fastStart: true
    })

    expect(args).toEqual([
      '-y',
      '-i', input,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-crf', '23',
      '-preset', 'medium',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      '-nostats',
      output
    ])
    expect(args).not.toContain(`"${input}"`)
  })

  it('uses VP9 constant-quality options instead of unsupported x264 presets', () => {
    const args = buildFFmpegArgs('/video/source.mkv', '/video/source.webm', {
      kind: 'video',
      videoCodec: 'libvpx-vp9',
      crf: 28,
      preset: 'veryfast',
      audioCodec: 'libopus',
      audioBitrateKbps: 128
    })

    expect(args).toEqual(expect.arrayContaining(['-b:v', '0', '-deadline', 'good', '-cpu-used', '6']))
    expect(args).not.toContain('-preset')
  })

  it('uses VideoToolbox quality controls without software-only CRF or preset flags', () => {
    const args = buildFFmpegArgs('/video/source.mov', '/video/source.mp4', {
      kind: 'video',
      videoCodec: 'h264_videotoolbox',
      crf: 23,
      preset: 'medium',
      audioCodec: 'aac'
    })

    expect(args).toEqual(expect.arrayContaining(['-c:v', 'h264_videotoolbox', '-q:v', '55']))
    expect(args).not.toContain('-crf')
    expect(args).not.toContain('-preset')
  })

  it('maps software presets and quality to modern NVENC controls', () => {
    const args = buildFFmpegArgs('/video/source.mkv', '/video/source.mp4', {
      kind: 'video',
      videoCodec: 'h264_nvenc',
      crf: 23,
      preset: 'veryfast',
      audioCodec: 'aac'
    })

    expect(args).toEqual(expect.arrayContaining([
      '-preset', 'p2', '-rc', 'vbr', '-cq:v', '23', '-b:v', '0'
    ]))
    expect(args).not.toContain('-crf')
  })

  it('builds audio-only arguments without video mapping', () => {
    const args = buildFFmpegArgs('/music/source.flac', '/music/source.mp3', {
      kind: 'audio',
      audioCodec: 'libmp3lame',
      bitrateKbps: 192,
      sampleRate: 48_000,
      channels: 2
    })

    expect(args).toContain('0:a:0')
    expect(args).toContain('libmp3lame')
    expect(args).toContain('48000')
    expect(args).not.toContain('0:v:0')
  })

  it('builds a single-frame image conversion with bounded dimensions', () => {
    const args = buildFFmpegArgs('/images/source.heic', '/images/source.webp', {
      kind: 'image',
      format: 'webp',
      quality: 82,
      width: 1600,
      keepAspectRatio: true
    })

    expect(args).toContain('scale=1600:-2')
    expect(args).toContain('-frames:v')
    expect(args).toContain('1')
  })

  it.each([
    { field: 'crf', options: { kind: 'video', videoCodec: 'libx264', crf: 99 } },
    { field: 'codec', options: { kind: 'video', videoCodec: '$(touch /tmp/pwned)', crf: 23 } },
    { field: 'bitrate', options: { kind: 'audio', audioCodec: 'aac', bitrateKbps: 0 } },
    { field: 'quality', options: { kind: 'image', format: 'jpg', quality: 101 } }
  ])('rejects invalid $field values', ({ options }) => {
    expect(() => buildFFmpegArgs(input, output, options as never)).toThrow()
  })

  it('rejects empty input and output paths', () => {
    expect(() => buildFFmpegArgs('', output, {
      kind: 'audio', audioCodec: 'aac', bitrateKbps: 128
    })).toThrow('input path')
  })
})
