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
- Queue UI with live progress, pause, resume, cancellation, mapped error messages, and reveal-in-folder; picking a file that has already finished puts its row back in the queue rather than ignoring the click
- Local DeepFilterNet3 noise removal for audio files and video soundtracks, with separate noise-reduction and speech-level controls, a waveform A/B preview, and per-file retry ([Audio cleanup](#audio-cleanup))
- ffprobe inspection of inputs (duration, codecs, resolution) before conversion
- Quality presets and media-specific output formats
- Hardware encoding and a configurable 1–4 job concurrency limit, persisted between launches
- Codec-specific tuning for VideoToolbox, NVENC, QSV, VP9, x264, and x265
- Single-viewport layout: the page never scrolls, only the file list and settings body do
- Two workspaces in one window, **Convert** and **Clean audio**, sharing the output folder and the file picker
- Light and dark themes, and six accents — violet, neon green, lime, orange, cyan and rose — chosen under Appearance in the settings dialog and remembered between launches. Each accent is the violet palette turned to a new hue by `npm run accents`, which re-solves every colour that carries text until it reaches the contrast the violet does, so the small labels stay as legible on all six. The app mark is turned with it by `npm run logos`, per pixel and in the same colour space, so its bevels and gloss survive the change of hue instead of being flattened to a tint
- One settings dialog behind the gear in the header, holding Appearance and the About panel: the FFmpeg version and the story behind the name
- Secure, allowlisted IPC bridge
- Unit tests for command generation, parsing, file handling, conversion lifecycle, hardware detection, settings persistence, queue state, and the denoiser's command builder, asset digest verification, queue service and store, level staging, pre-gain, and streaming pump, plus a separate integration suite that drives the real FFmpeg binary and the real model — including a re-measurement of the model's lookahead delay and of what its attenuation limit means, proof that a fresh model state renders a file identically twice while a used one does not, and a multi-stream remux that must come out with its extra tracks and chapters intact, so a model or a container change that differs on any of it fails the build rather than quietly desyncing video, dropping tracks, rendering the second file in a queue differently from the first, or making the panel's percentages fiction

Roadmap work still open: queue reordering, per-codec advanced options, named presets, output naming rules, keyboard shortcuts, metadata preservation, logging, auto-update, and real-time microphone denoising. Signing and notarization are wired into the build but inert until certificates exist — see [Signing releases](#signing-releases).

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

Builds produced this way are unsigned, because signing switches on only when credentials are present in the environment — see [Signing releases](#signing-releases). Windows SmartScreen and macOS Gatekeeper will warn about an unidentified developer. The macOS app is ad-hoc signed, which is enough to run on the machine that built it, but a copy carried to another Mac arrives quarantined; clear it with `xattr -dr com.apple.quarantine "/Applications/Hope Converter.app"`, which is more reliable on recent macOS than the right-click-Open trick. If a build fails, run `npm test` and `npm run test:integration` first — the integration suite spawns the real binaries and will tell you whether FFmpeg works on your machine at all.

## Development

### Requirements

- Node.js 22 or newer (an active LTS release is recommended)
- npm 10 or newer

### Install and run

```bash
git clone https://github.com/solomonyakubu/hope-converter.git
cd hope-converter
npm install
npm run fetch:models # once, to enable the audio cleanup tab
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

### Signing releases

Build settings live in `electron-builder.cjs` rather than `package.json` so that signing can be conditional. Every credential arrives through the environment, and the config only decides which path to take from which variables are set. An empty environment produces the unsigned, ad-hoc-signed build described above; no local workflow changes when credentials appear.

**macOS** needs an Apple Developer Program membership ($99/year) and a *Developer ID Application* certificate — not *Apple Distribution*, which is Mac App Store only and gets rejected for direct distribution. Set `CSC_LINK` (base64 `.p12`) and `CSC_KEY_PASSWORD`, or `CSC_NAME` for a certificate already in the login keychain. That alone stops the "unidentified developer" wording but not the warning; notarization is what removes it, and needs either `APPLE_API_KEY` (a *path* to the App Store Connect `.p8`, not its contents), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`, or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Hardened runtime and the entitlements Electron needs are already on by default; a custom plist would go at `resources/entitlements.mac.plist`, following `buildResources` rather than the `build/` the electron-builder docs assume. Verify a finished build with `codesign -dv --verbose=4`, `spctl -a -vvv -t install`, and `xcrun stapler validate`.

**Windows** signing does not clear SmartScreen the way notarization clears Gatekeeper — EV certificates stopped bypassing it in 2024, so every option now accumulates reputation across consistently signed releases instead. Azure Artifact Signing, formerly Trusted Signing, is roughly $10/month and reads `AZURE_CODE_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT`, `AZURE_CODE_SIGNING_PROFILE`, and optionally `AZURE_PUBLISHER_NAME`, authenticating through `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`; individual developers are limited to the US and Canada. A traditional signtool certificate goes in `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` instead, though OV private keys have had to live on hardware since June 2023. [SignPath Foundation](https://signpath.io) signs qualifying open-source projects for free.

Once a certificate is configured for a platform, `forceCodeSigning` makes a signing failure fail the build rather than quietly ship something the OS will reject.

`.github/workflows/release.yml` reads all of this from repository secrets on a `v*` tag, builds each platform on its own runner, and collects the installers into a **draft** GitHub release. It succeeds with no secrets configured at all, so it can be merged before any certificate is bought.

## Architecture

- `electron/main.ts` owns windows, native dialogs, IPC validation, and OS integration.
- `electron/preload.ts` exposes a narrow typed API; the renderer never receives Node or raw Electron APIs.
- `electron/ffmpeg/` contains pure command generation, progress parsing, probing, hardware detection, and process lifecycle management.
- `electron/denoise/` holds the DeepFilterNet3 denoiser: asset resolution, the wasm engine wrapper, the FFmpeg-piping pipeline, and the worker threads that own them. The main process holds the queue and relays events; a worker owns one request.
- `src/` contains the sandboxed React renderer, Zustand queue state, and persisted renderer settings.
- `tests/unit/` contains fast unit tests for the engine and renderer state; `tests/integration/` exercises the real bundled binaries.

FFmpeg is spawned directly with an argument array and `shell: false`. Conversion options are represented as discriminated TypeScript types and checked against codec and numeric allowlists before process creation.

The denoiser runs in `worker_threads` workers so the wasm model never blocks the main process or the UI. Each request — a file or an A/B preview — gets a thread of its own, which is terminated once the request settles. That is not tidiness: a model state carries recurrent history that nothing can clear (`df_create` hands out a pointer wasm-bindgen cannot free, and the wasm glue keeps one module instance per thread), so a second file rendered on a used state comes out differently from the way a fresh run renders it — 20.6 dB quieter on the integration suite's fixture, where two fresh states agree bit for bit. To keep that from costing a model load per file, one loaded thread stands by and its replacement starts the moment it is claimed, so in a queue the next file's model load happens while the current file is being processed; at most two threads are alive at once, and the assets are verified once per app run rather than once per file. Audio streams through in frames of 480 samples, so a two-hour file costs the same memory as a ten-second one, and output goes to a `.part` sibling that is only renamed into place once both FFmpeg processes have exited cleanly.

## Supported MVP formats

| Media | Input                                    | Output              |
| ----- | ---------------------------------------- | ------------------- |
| Video | MP4, MOV, MKV, AVI, WebM, M4V, FLV, WMV  | MP4, WebM, MOV      |
| Audio | MP3, WAV, FLAC, AAC, M4A, OGG, Opus, WMA | MP3, WAV, FLAC, M4A |
| Image | JPG, PNG, WebP, HEIC, TIFF, BMP, GIF     | JPG, PNG, WebP      |

Actual decode/encode availability is determined by the bundled FFmpeg build and may vary by platform.

Audio cleanup accepts any of those audio and video inputs and writes FLAC (24-bit), WAV (24-bit PCM), MP3, or M4A for audio. A video keeps its own container, except AVI, FLV, and WMV, which are rebuilt as MKV — the picture is still copied untouched, just into a wrapper that takes the new soundtrack without complaint. What else survives the remux depends on the container: see [Using it](#using-it).

## Audio cleanup

The **Clean audio** tab removes steady background noise — hiss, hum, fans, air conditioning, room tone — from a recording or from a video's soundtrack. It runs [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) as WebAssembly inside the app. Nothing is uploaded, and no network request is made while it works.

### One-time setup

The model is not committed to the repository (~17 MB of binaries), so fetch it once per checkout:

```bash
npm run fetch:models
```

`npm run build`, `npm run package`, and `npm run dist` call this for you. `npm run dev` does not — run it yourself before starting the dev server, or the tab will open with "`df_bg.wasm` is missing…" and stay disabled. The rest of the app is unaffected either way.

### Using it

1. Open the **Clean audio** tab.
2. Drop in audio or video files, or press **Browse**. Files without an audio track are labelled and skipped.
3. Set **Noise reduction** — the choices are Gentle (6), Balanced (12, the default), Strong (18), and Maximum (24). The number is the model's attenuation limit in dB, which is the same number as the share of the original recording kept underneath the result: 6 dB keeps half of it, 12 dB a quarter, 24 dB a sixteenth. That kept share is what protects speech the model misread as noise, so the panel names it under the buttons — see [Getting the most speech through](#getting-the-most-speech-through).
4. Pick an **Output level**: *As recorded*, *Lift quiet voice*, or *Even loudness* (−16 LUFS). The last two are FFmpeg stages that run after the model — see [The level controls](#the-level-controls).
5. Everything in dB lives under **Fine controls** at the bottom of the panel, closed by default: the reduction slider (0–24, so 0 passes the audio through untouched), the speech lift in dB (0–18), and the post-filter.
6. Press the headphones button on a row to hear the first 8 seconds before and after, in the A/B player: one waveform per version, click or drag anywhere on it to seek, space to play, **A**/**B** to switch sides mid-sentence, and a level-match toggle so the louder version does not simply win. The caption names the settings the clips were rendered with, so a preview left behind by moved sliders is obvious. The cleaned half carries the noise reduction and the speech lift, but never **Even loudness**: that target is set over a whole file, so applying it to an 8-second excerpt would land the excerpt somewhere the finished file will not, and make the louder clip win the comparison the player exists to make.
7. Choose where cleaned files go, then press **Clean**.

If a result is not right, change the settings and press the retry button on that row. It cleans that one file again and replaces the copy already written rather than piling up numbered variants.

Each result is written beside the original name with `-denoised` added — `interview.mov` becomes `interview-denoised.mp4`. Audio files are written in the format chosen under **Output**: FLAC by default (24-bit), or 24-bit PCM WAV, MP3, or M4A. Every path decodes to 48 kHz float and re-encodes, so a cleaned file is a new encode rather than an edit of the original — for a video that means the soundtrack is re-encoded (AAC, or Opus for WebM) while **the picture is copied, never re-encoded**, so there is no generation loss in the video.

What else the remux keeps depends on what the container can legally hold. Every video stream, the chapters, and the file-level metadata are carried in all cases. Matroska targets (`.mkv`, and the AVI/FLV/WMV inputs rebuilt as MKV) also keep the other audio tracks, the subtitles, and any attachments, copied rather than re-encoded. MP4, M4V, MOV, and WebM cannot legally carry an arbitrary subtitle or audio codec — image-based subtitles have no MP4 representation, AC-3 is not valid in WebM — so those tracks are dropped rather than failing the whole job, and the panel says on the row exactly how many are being left behind before you press **Clean**.

Files are processed one at a time; the rest of the queue waits at "Ready". Each file is cleaned on a model state that has processed nothing else, so the fifth file in a queue comes out exactly as it would have on its own, and a retry re-renders a row exactly as a first attempt would — the thread carrying the model is replaced between files, and the next one is loaded while the current file is still running, so that costs no waiting. Progress and speed are reported per file, a running file can be stopped, and switching back to **Convert** does not interrupt anything. A file whose duration FFprobe could not read shows a moving bar and an elapsed-audio clock instead of a percentage, since there is nothing to be a percentage of.

### The level controls

The model has no volume control of its own — it takes noisy audio and returns clean audio at the level it arrived. Loudness is therefore a separate FFmpeg stage that runs after the denoising, and it comes in two kinds, which is why **Output level** offers three answers rather than two:

- **Noise reduction** is the model. It decides how much of what it hears is not speech.
- **Lift quiet voice** raises quiet speech toward the peak afterwards (`speechnorm`), by the dB shown under **Fine controls**. At 0, with **Even loudness** off, no `-af` reaches FFmpeg at all, so the samples handed to the encoder are the model's own — the file is still an encode in the chosen format, but nothing has touched its levels. It evens out one file; it does not know what any other file sounds like.
- **Even loudness** sets the absolute integrated loudness to −16 LUFS (`loudnorm`), which is what makes recordings from different sessions sit at the same level next to each other. If a lift is also set, both run — the lift shapes what reaches the target, and the target has the last word on how loud the file lands. Because the target is integrated over the whole file, it is the one setting the 8-second A/B preview cannot honestly show.

**Noise reduction is a dry/wet mix rather than a threshold**, which is a measured claim rather than an analogy. DeepFilterNet3's attenuation limit emits `alpha * original + (1 - alpha) * enhanced` with `alpha = 10 ** (-dB / 20)`; fitting that single parameter against the bundled model reproduces its output to five decimals at every limit from 3 to 100 dB, with and without the post-filter, on noise and on voice alike. The dB number and the percentage the panel quotes are therefore one setting read from either end, and `tests/integration/real-denoise.test.ts` pins it so a model that means something else by its limit fails the build. What this model cannot do is give genuinely independent speech and background levels, since it returns one enhanced signal rather than separate stems.

### Getting the most speech through

Two corrections happen automatically, both worth knowing about because they were the cause of speech sounding clipped in earlier builds:

- **Alignment.** The model looks ahead before it decides, so its output lags its input by exactly three frames — 30 ms, measured by cross-correlation against the bundled model. The pipeline drops that much from the front and flushes the same amount back out at the end, so a cleaned file is exactly as long as the original, keeps the tail of its last word, and a video's soundtrack stays in sync with its picture.
- **Input level.** The model is not level invariant, and quietly recorded audio was where the worst damage came from. Handed a file peaking 35 dB below full scale, the model stopped telling speech from noise and simply attenuated *everything* by the limit — at 30 dB reduction the loudest speech frames came back 29.9 dB down, which is the whole voice turned off. Lifted into a healthy range first, the same frames come back 0.3 dB down. So the first second of audio is measured, a pre-gain is applied on the way into the model, and each frame coming back is divided by **the lift that frame went in at** rather than whatever is in force three frames later: the model sees a level it behaves at, and the written file keeps the level it always had, sample for sample, not merely at its peak. The lift is also held under +6 dBFS as the file goes by, so a recording that opens on room tone and later gets loud is not over-driven instead — past about +12 dBFS the model starts gating loud speech (−11.7 dB at +20).

  The lift is chosen once, from roughly the first second, and can afterwards only fall. That is a real limitation and not a hidden one: a recording that starts loud and later drops to a whisper gets no lift on the whisper. Fixing it properly means an envelope-following gain, which changes what the model hears everywhere and needs listening tests rather than a unit test, so it is a separate proposal rather than a quiet change here.

**The reduction setting is the other half of this.** Whatever the model does not hold as speech survives only in the share of the original the limit keeps, and the quiet end of a word is exactly what it is least sure about. Measured against the bundled model on speech at a 10 dB SNR, with the pre-gain doing its job, here is what each setting did to speech frames grouped by how loud they are relative to the loudest speech:

| Reduction | Keeps | Loud speech | −15 to −25 dB | −25 to −35 dB | −35 to −50 dB | Noise removed |
| --- | --- | --- | --- | --- | --- | --- |
| 12 (Balanced, default) | 25% | −0.2 dB | −0.2 dB | −1.6 dB | −1.5 dB | 12 dB |
| 30 (not offered) | 3.2% | −0.3 dB | −0.3 dB | −2.9 dB | −19.1 dB | 30 dB |
| 60 (not offered) | 0.1% | −0.3 dB | −0.3 dB | −3.1 dB | −49.1 dB | 60 dB |
| 100 (not offered) | 0.001% | −0.3 dB | −0.3 dB | −3.1 dB | −189 dB | 175 dB |

Ordinary speech survives all of them. The last column of quiet material — breaths, trailing consonants, the ends of unstressed words — is what the setting actually decides, and it falls off a cliff between 12 and 24 (−13 dB at 24, −19 dB at 30) while the noise reduction stops paying at the same point: on voice in noise, 24 dB and 100 dB differ by 0.3 dB of total level. That is why the slider stops at 24 and the default sits at 12. Earlier builds offered up to 100 and defaulted to 30, which is where the reports of clipped speech came from; if speech still sounds clipped, the fix is to go **down**.

The engine itself still accepts the model's full 0–100 range, since that is the range the model documents and what the integration suite drives it across. Only the control is bounded.

### What it is good at, and what it is not

DeepFilterNet3 is a **speech enhancement** model. It is trained to keep a voice and discard everything else, which is exactly right for interviews, voice memos, lectures, and screen recordings.

It is not a general-purpose noise gate. Music, ambience, sound effects, and other non-speech audio can be suppressed along with the noise, and at Maximum a recording with no speech in it comes back 24 dB down — most of the way to inaudible. Preview one file before running a batch.

Other limits worth knowing:

- Audio is resampled to 48 kHz, which is the only rate the model runs at.
- Mono and stereo are processed with one model state per channel. Anything wider is downmixed to stereo on the way in.
- Live microphone processing is not implemented. It would need the renderer to hold an open capture stream, which the current sandbox and CSP deliberately do not allow; it is a possible follow-up rather than a missing piece of this feature.

### Where the assets come from

`npm run fetch:models` downloads two files into `resources/deepfilternet3/` and verifies each against a SHA-256 digest pinned in [`electron/denoise/asset-manifest.json`](./electron/denoise/asset-manifest.json). A file whose digest does not match is discarded and the script fails.

The app re-checks the same digests every time the denoiser starts. The manifest is imported by [`electron/denoise/assets.ts`](./electron/denoise/assets.ts), so the digests are compiled into the bundle rather than shipped as a swappable file beside the assets, and each file is hashed once per app run before anything is loaded. A file replaced or truncated *after* setup therefore fails closed — the tab reports the mismatch and stays disabled instead of loading it.

| File | Source | Why |
| --- | --- | --- |
| `DeepFilterNet3_onnx.tar.gz` | [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) at tag `v0.5.6` | The model weights, straight from upstream |
| `df_bg.wasm` | CDN mirror of the same project's `libDF --features wasm` build | Upstream publishes no prebuilt `.wasm`, so it is mirrored and pinned by digest |

The matching wasm-bindgen glue is vendored verbatim at [`electron/denoise/vendor/df-bindings.js`](./electron/denoise/vendor/df-bindings.js). It pairs with that exact `df_bg.wasm`, so the two must be replaced together. Only `initAsync(bytes)` is used, which takes the compiled bytes directly — no initializer in the app fetches anything.

Packaged builds ship both files through electron-builder's `extraResources`, beside the app rather than inside the asar, so they can be read as plain files at runtime.

## Security and privacy

- `contextIsolation`, renderer sandboxing, and web security are enabled.
- Node integration is disabled in the renderer.
- New windows and renderer navigation are denied.
- A restrictive Content Security Policy is applied.
- IPC payloads and FFmpeg options are validated in the main process.
- Processes are launched without a shell, so paths with spaces and shell metacharacters remain plain arguments.
- The denoiser's model and WebAssembly are downloaded once at setup time and verified against SHA-256 digests compiled into the app, which are re-checked at every load, so a file swapped after setup fails closed rather than running. The application itself makes no network requests at runtime — neither conversion nor audio cleanup reaches the network.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the local development gate, the security rules a change must not break, and the roadmap items that are good to pick up.

Please report security vulnerabilities through a private security advisory on the repository's Security tab rather than a public issue.

## License

Hope Converter's source is released under the [MIT License](./LICENSE).

### FFmpeg licensing

FFmpeg and ffprobe are not part of this repository. They are downloaded at install time by the `ffmpeg-static` and `@ffprobe-installer/ffprobe` packages, and they carry their own licenses — the prebuilt binaries those packages provide are GPL-licensed builds, which is more restrictive than this project's MIT license.

That distinction does not affect local development or personal use, but distributing packaged builds means distributing FFmpeg too. Check the license and codec configuration of the exact binary you ship, and the patent situation for the codecs you enable in your target jurisdictions, before publishing releases. This note is a pointer, not legal advice.

### DeepFilterNet licensing

The DeepFilterNet3 model weights and the `libDF` WebAssembly build are not part of this repository either — they are downloaded by `npm run fetch:models`. [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) is dual-licensed Apache-2.0 OR MIT, and the vendored wasm-bindgen glue in `electron/denoise/vendor/` carries that same license and its provenance in a header comment. Packaged builds redistribute both files, so keep the upstream license and attribution with them.
