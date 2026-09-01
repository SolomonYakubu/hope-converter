/**
 * Types for the vendored wasm-bindgen glue in `df-bindings.js`. Hand-written
 * because the project builds with `allowJs: false`.
 */

/** Compiles and instantiates the module from bytes. Repeat calls are no-ops. */
export function initAsync(moduleOrBytes: BufferSource | WebAssembly.Module): Promise<unknown>

/**
 * Loads a DeepFilterNet model and returns an opaque state pointer. The state
 * is mono and carries its own overlap-add history, so one is needed per
 * channel. There is no way to free it — see the note in `df-bindings.js`.
 *
 * @param modelBytes Contents of `DeepFilterNet3_onnx.tar.gz`.
 * @param attenLim Attenuation limit in dB: 0 passes audio through, 100 lets
 *   the model suppress freely.
 */
export function df_create(modelBytes: Uint8Array, attenLim: number): number

/** Frame size the model consumes and emits, in samples (480 at 48 kHz). */
export function df_get_frame_length(state: number): number

/** Changes the attenuation limit on a live state. */
export function df_set_atten_lim(state: number, limDb: number): void

/** Post-filter beta; 0 disables it. */
export function df_set_post_filter_beta(state: number, beta: number): void

/**
 * Denoises exactly one frame. The returned view aliases wasm memory and is
 * invalidated by the next call, so copy out of it before continuing.
 *
 * The output lags the input: the model looks ahead, and nothing here compensates
 * for that, so frame *n* out is the cleaned frame *n − 3* in. Callers have to
 * realign — see `DENOISE_DELAY_FRAMES` in `../engine.ts` for the measurement and
 * `../pipeline.ts` for the compensation.
 */
export function df_process_frame(state: number, input: Float32Array): Float32Array
