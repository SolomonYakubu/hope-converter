// `@ffprobe-installer/ffprobe` ships no types. It resolves to a platform package
// (for example `@ffprobe-installer/darwin-arm64`) whose binary matches the host
// architecture, which `ffprobe-static` does not do on Apple Silicon.
declare module '@ffprobe-installer/ffprobe' {
  const ffprobeInstaller: {
    path: string
    version: string
  }
  export default ffprobeInstaller
}
