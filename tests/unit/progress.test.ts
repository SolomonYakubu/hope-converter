import { describe, expect, it } from 'vitest'
import { parseProgressBlock } from '../../electron/ffmpeg/progress'

describe('parseProgressBlock', () => {
  it('calculates bounded percentage and speed from FFmpeg progress output', () => {
    expect(parseProgressBlock([
      'frame=240',
      'out_time_us=5000000',
      'speed=1.25x',
      'progress=continue'
    ].join('\n'), 10)).toEqual({
      frame: 240,
      timeSeconds: 5,
      percent: 50,
      speed: 1.25,
      state: 'continue'
    })
  })

  it('supports FFmpeg out_time_ms and clamps percentage at 100', () => {
    const result = parseProgressBlock('out_time_ms=12000000\nspeed=N/A\nprogress=end', 10)
    expect(result.percent).toBe(100)
    expect(result.speed).toBeNull()
    expect(result.state).toBe('end')
  })

  it('returns zero percentage when duration is unavailable', () => {
    expect(parseProgressBlock('out_time_us=5000000\nprogress=continue', 0).percent).toBe(0)
  })
})
