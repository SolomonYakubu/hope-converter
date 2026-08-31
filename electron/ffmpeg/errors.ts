const ERROR_RULES: ReadonlyArray<{ pattern: RegExp, message: string }> = [
  {
    pattern: /invalid data found|moov atom not found|error while decoding|corrupt|could not find codec parameters/i,
    message: 'The input file is invalid or corrupt.'
  },
  {
    pattern: /unknown (?:encoder|decoder)|encoder .* not found|decoder .* not found|unsupported codec|codec .* not supported|could not find encoder/i,
    message: 'The requested codec or encoder is not supported by this FFmpeg build.'
  },
  {
    pattern: /permission denied|operation not permitted|access is denied/i,
    message: 'FFmpeg does not have permission to read the input or write the output.'
  },
  {
    pattern: /no space left on device|disk full|not enough space/i,
    message: 'The destination disk does not have enough free space.'
  },
  {
    pattern: /does not contain any stream|matches no streams|stream map .* matches no streams|cannot find a matching stream|output file .* contains no stream/i,
    message: 'The input does not contain the required media stream.'
  },
  {
    pattern: /file already exists|not overwriting|same as input|cannot edit existing files in-place/i,
    message: 'The output file already exists or conflicts with the input.'
  },
  {
    pattern: /immediate exit requested|received signal 15|exiting normally, received signal|operation canceled|operation cancelled/i,
    message: 'The conversion was cancelled.'
  }
]

export function mapFFmpegError(stderr: string): Error {
  for (const rule of ERROR_RULES) {
    if (rule.pattern.test(stderr)) return new Error(rule.message)
  }
  return new Error('FFmpeg could not complete the conversion. Check the input and output settings and try again.')
}
