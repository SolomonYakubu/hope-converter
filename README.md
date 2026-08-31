# Hope Converter

<!-- [![CI](https://github.com/solomonyakubu/hope-converter/actions/workflows/ci.yml/badge.svg)](https://github.com/solomonyakubu/hope-converter/actions/workflows/ci.yml) -->

Hope Converter is a private, cross-platform desktop application for converting video, audio, and images locally with FFmpeg. Files never leave the device.

It is named after Hope, who kept needing to convert videos and kept ending up on online tools — uploads, waiting, and her files sitting on someone else's server. This is that job done properly, on your own machine.

## Current milestone

The application is functional end to end:

- Electron + React + TypeScript application shell
- Bundled FFmpeg and ffprobe binaries
- Video, audio, and image conversion command generation
- Native multi-file picker, drag-and-drop, and output directory picker
- Queue UI with live progress, pause, resume, cancellation, mapped error messages, and reveal-in-folder
- ffprobe inspection of inputs (duration, codecs, resolution) before conversion
- Quality presets and media-specific output formats
- Hardware encoding and a configurable 1–4 job concurrency limit, persisted between launches
- Codec-specific tuning for VideoToolbox, NVENC, QSV, VP9, x264, and x265
- Single-viewport layout: the page never scrolls, only the file list and settings body do
- Light and dark themes with a custom lime design system
- About dialog carrying the FFmpeg version and the story behind the name
- Secure, allowlisted IPC bridge
- Unit tests for command generation, parsing, file handling, conversion lifecycle, hardware detection, settings persistence, and queue state, plus a separate integration suite

Roadmap work still open: queue reordering, per-codec advanced options, named presets, output naming rules, keyboard shortcuts, metadata preservation, logging, auto-update, and signing/notarization.

## Platform support

**Apple Silicon macOS is the only platform with a prebuilt download.** That is also the only platform where the app has had hands-on testing. The code is cross-platform and CI runs the full gate on Linux, macOS, and Windows, but Windows and Linux builds are currently source-only and unverified in practice — treat them as working-but-untested and please report what breaks.

| Platform | Status | How to get it |
| --- | --- | --- |
| macOS, Apple Silicon | Tested | Prebuilt DMG, or build from source |
| macOS, Intel | Untested | Build from source on an Intel Mac |
| Windows x64 | Untested, CI-verified | Build from source |
| Linux x64 | Untested, CI-verified | Build from source |

### Building for your own platform

FFmpeg and ffprobe are downloaded during `npm install` and match the machine doing the installing, so **build on the platform and architecture you intend to run on**. Cross-building from Apple Silicon with `--x64` produces an app carrying arm64 binaries, which will not run.

```bash
git clone https://github.com/solomonyakubu/hope-converter.git
cd hope-converter
npm install
npm run dist
```

Installers land in `release/`:

- **Windows** — an NSIS installer and a portable `.exe`
- **Linux** — an AppImage and a `.deb` (`chmod +x` the AppImage before running it)
- **macOS** — a `.dmg` and a `.zip`

Builds produced this way are unsigned. Windows SmartScreen and macOS Gatekeeper will warn about an unidentified developer; on macOS, right-click the app and choose Open the first time. If a build fails, run `npm test` and `npm run test:integration` first — the integration suite spawns the real binaries and will tell you whether FFmpeg works on your machine at all.

## Development

### Requirements

- Node.js 22 or newer (an active LTS release is recommended)
- npm 10 or newer

### Install and run

```bash
git clone https://github.com/solomonyakubu/hope-converter.git
cd hope-converter
npm install
npm run dev
```

### Validation

```bash
npm test
npm run test:integration # real-binary suites, slower
npm run typecheck
npm run build
```

### Packaging

```bash
npm run package # unpacked application for the current platform
npm run dist    # distributable targets for the current platform
```

Both build for the host platform and architecture only. See [Platform support](#platform-support) for why cross-architecture builds do not work.

Code signing and macOS notarization credentials are required for trusted public distribution but are not needed for local development builds.

## Architecture

- `electron/main.ts` owns windows, native dialogs, IPC validation, and OS integration.
- `electron/preload.ts` exposes a narrow typed API; the renderer never receives Node or raw Electron APIs.
- `electron/ffmpeg/` contains pure command generation, progress parsing, probing, hardware detection, and process lifecycle management.
- `src/` contains the sandboxed React renderer, Zustand queue state, and persisted renderer settings.
- `tests/unit/` contains fast unit tests for the engine and renderer state; `tests/integration/` exercises the real bundled binaries.

FFmpeg is spawned directly with an argument array and `shell: false`. Conversion options are represented as discriminated TypeScript types and checked against codec and numeric allowlists before process creation.

## Supported MVP formats

| Media | Input                                    | Output              |
| ----- | ---------------------------------------- | ------------------- |
| Video | MP4, MOV, MKV, AVI, WebM, M4V, FLV, WMV  | MP4, WebM, MOV      |
| Audio | MP3, WAV, FLAC, AAC, M4A, OGG, Opus, WMA | MP3, WAV, FLAC, M4A |
| Image | JPG, PNG, WebP, HEIC, TIFF, BMP, GIF     | JPG, PNG, WebP      |

Actual decode/encode availability is determined by the bundled FFmpeg build and may vary by platform.

## Security and privacy

- `contextIsolation`, renderer sandboxing, and web security are enabled.
- Node integration is disabled in the renderer.
- New windows and renderer navigation are denied.
- A restrictive Content Security Policy is applied.
- IPC payloads and FFmpeg options are validated in the main process.
- Processes are launched without a shell, so paths with spaces and shell metacharacters remain plain arguments.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the local development gate, the security rules a change must not break, and the roadmap items that are good to pick up.

Please report security vulnerabilities through a private security advisory on the repository's Security tab rather than a public issue.

## License

Hope Converter's source is released under the [MIT License](./LICENSE).

### FFmpeg licensing

FFmpeg and ffprobe are not part of this repository. They are downloaded at install time by the `ffmpeg-static` and `@ffprobe-installer/ffprobe` packages, and they carry their own licenses — the prebuilt binaries those packages provide are GPL-licensed builds, which is more restrictive than this project's MIT license.

That distinction does not affect local development or personal use, but distributing packaged builds means distributing FFmpeg too. Check the license and codec configuration of the exact binary you ship, and the patent situation for the codecs you enable in your target jurisdictions, before publishing releases. This note is a pointer, not legal advice.
