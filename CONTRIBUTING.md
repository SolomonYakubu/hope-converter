# Contributing to Hope Converter

Thanks for considering a contribution. Hope Converter converts video, audio, and
images locally with FFmpeg — nothing is ever uploaded. Every change should
protect that promise.

## Getting started

```bash
git clone https://github.com/solomonyakubu/hope-converter.git
cd hope-converter
npm install
npm run dev
```

You need Node.js 22 or newer and npm 10 or newer. `npm install` downloads the
FFmpeg and ffprobe binaries through `ffmpeg-static` and `ffprobe-static`, so the
first install needs network access.

## Before you open a pull request

Run the full local gate. CI runs the same commands on Linux, macOS, and Windows.

```bash
npm run typecheck
npm test
npm run build
```

`npm run test:integration` exercises the real bundled binaries. It is slower and
not part of the default `npm test` run, but please run it when you touch
anything under `electron/ffmpeg/`.

## How we work

- **Tests come first.** New behaviour starts with a failing test. Bug fixes start
  with a test that reproduces the bug. Unit tests live in `tests/unit/`;
  suites that spawn the real binaries live in `tests/integration/`.
- **Keep the security model intact.** `contextIsolation`, renderer sandboxing,
  and web security are on; Node integration is off; new windows and navigation
  are denied. The renderer talks to the main process only through the
  allowlisted preload bridge. A pull request that widens the bridge should say
  why in its description.
- **Validate in the main process.** Anything arriving over IPC is untrusted.
  Conversion options are discriminated unions checked against codec and numeric
  allowlists before a process is created, and FFmpeg is spawned with an argument
  array and `shell: false`. Never build a command string.
- **Match the surrounding code.** No formatter or linter runs in CI, so follow
  the style already in the file: two-space indent, no semicolons, single quotes,
  named exports, and comments that explain *why* rather than restating the code.
- **Design changes belong in `src/styles.css`.** The UI is a hand-written design
  system built on CSS custom properties: dark values on `:root`, light overrides
  under `:root[data-theme='light']`. Add tokens rather than hard-coded colours,
  and keep both themes working.
- **Respect the single-viewport layout.** The window never page-scrolls; only the
  file list and the settings body scroll internally. If a change adds height,
  make it fit or make it scroll inside its own panel.
- **Accessibility is not optional.** Interactive elements need accessible names,
  keyboard operation, and visible focus.

## Commit and pull request style

Write commit subjects in the imperative mood and keep them under about 70
characters (`Add pause and resume to the conversion queue`). Explain the
reasoning in the body when it is not obvious.

A good pull request describes what changed, why, and how you verified it, and
notes anything you could not test on your platform — most contributors can only
verify one operating system.

## Reporting bugs

Open an issue at
https://github.com/solomonyakubu/hope-converter/issues with your OS and version,
the app version, what you converted (format in, format out, settings), what you
expected, and what happened. If a conversion failed, include the error message
the app displayed.

Please do not report security vulnerabilities in a public issue. Open a private
security advisory through the repository's Security tab instead.

## Scope

The roadmap items most useful to pick up right now:

- queue reordering
- per-codec advanced options (CRF/bitrate, resolution, fps, sample rate)
- named presets and output naming rules
- keyboard shortcuts
- metadata preservation
- Windows and Linux verification of anything currently confirmed only on macOS

Features that would send user files anywhere off the device are out of scope.
