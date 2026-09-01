/**
 * electron-builder configuration.
 *
 * This lives in its own file rather than in package.json's `build` field
 * because signing has to be conditional. A checkout with no certificates must
 * still produce an app that runs, and a build that does have certificates must
 * refuse to quietly fall back to an unsigned one. Expressing that needs code.
 *
 * No secret is read or written here. Credentials reach electron-builder purely
 * through the environment — see `.github/workflows/release.yml` — and the flags
 * below only decide which signing path to take from which vars are present.
 * With an empty environment every flag is false and the result is byte-for-byte
 * the unsigned build this project produced before.
 */

/**
 * A Developer ID Application certificate, either as a base64 `.p12` in
 * `CSC_LINK` or as a keychain identity name in `CSC_NAME`.
 */
const hasAppleCertificate = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)

/**
 * One complete set of notarization credentials. electron-builder throws on a
 * half-filled set, so all three of a group have to be present to count. The
 * App Store Connect API key is the group to prefer on CI: it carries no 2FA
 * and does not expire. `APPLE_API_KEY` is a *path* to the `.p8`, not its
 * contents, which is why the workflow decodes its secret to a file first.
 */
const hasAppleNotarizationCredentials = Boolean(
  (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
    (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
    process.env.APPLE_KEYCHAIN_PROFILE,
)

/** Azure Artifact Signing, formerly Trusted Signing. Windows only. */
const hasAzureSigning = Boolean(
  process.env.AZURE_CODE_SIGNING_ENDPOINT &&
    process.env.AZURE_CODE_SIGNING_ACCOUNT &&
    process.env.AZURE_CODE_SIGNING_PROFILE,
)

/**
 * A traditional Authenticode certificate for signtool, which is also the path
 * a SignPath or OV/HSM setup takes. electron-builder picks the file and its
 * password up from the environment on its own; the flag exists only so a
 * failure to use them is fatal rather than silent.
 */
const hasWindowsCertificate = Boolean(process.env.WIN_CSC_LINK)

module.exports = {
  appId: 'com.hopeconverter.app',
  productName: 'Hope Converter',
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  files: ['out/**/*', 'package.json'],
  asarUnpack: ['node_modules/ffmpeg-static/**/*', 'node_modules/@ffprobe-installer/**/*'],
  extraResources: [
    {
      from: 'resources/deepfilternet3',
      to: 'deepfilternet3',
      filter: ['df_bg.wasm', 'DeepFilterNet3_onnx.tar.gz'],
    },
  ],
  mac: {
    target: ['dmg', 'zip'],
    icon: 'resources/icon.png',
    category: 'public.app-category.video',
    // Apple Silicon will not launch a bundle that carries no signature at all,
    // so an unsigned build still has to be ad-hoc signed: that is what
    // `identity: '-'` does. Omitting the key entirely is what lets
    // electron-builder discover the real Developer ID certificate, so the key
    // has to disappear rather than change value.
    ...(hasAppleCertificate ? {} : { identity: '-' }),
    // Hardened runtime is already on by default, and the entitlements
    // electron-builder falls back to (`allow-jit`,
    // `allow-unsigned-executable-memory`, `disable-library-validation`) are the
    // ones V8, the wasm denoiser, and the unpacked FFmpeg binaries need. A
    // custom plist would go at `resources/entitlements.mac.plist`, following
    // `buildResources` above rather than the `build/` the docs assume.
    //
    // Notarizing an ad-hoc signature always fails, so it is only worth
    // attempting with a real certificate and credentials to go with it.
    notarize: hasAppleCertificate && hasAppleNotarizationCredentials,
    // Once a certificate is present, a signing failure should stop the build
    // instead of shipping something Gatekeeper rejects on the user's machine.
    forceCodeSigning: hasAppleCertificate,
  },
  win: {
    target: ['nsis', 'portable'],
    icon: 'resources/icon.png',
    ...(hasAzureSigning
      ? {
          azureSignOptions: {
            endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
            codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
            certificateProfileName: process.env.AZURE_CODE_SIGNING_PROFILE,
            ...(process.env.AZURE_PUBLISHER_NAME
              ? { publisherName: process.env.AZURE_PUBLISHER_NAME }
              : {}),
          },
        }
      : {}),
    forceCodeSigning: hasAzureSigning || hasWindowsCertificate,
  },
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'resources/icon.png',
    category: 'AudioVideo',
  },
}
