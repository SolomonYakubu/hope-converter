export function unpackedBinaryPath(binaryPath: string): string {
  return binaryPath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')
}
