const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*':\s*/
const ERROR_NAME_PREFIX = /^[A-Za-z]*Error:\s*/

const FALLBACK_MESSAGE = 'Hope Converter could not complete that request.'

/**
 * Electron wraps every `ipcRenderer.invoke` rejection as
 * `Error invoking remote method '<channel>': Error: <message>`. Users should
 * only ever see the message the main process actually produced.
 */
export function cleanIpcErrorMessage(message: string): string {
  let cleaned = message.trim().replace(REMOTE_METHOD_PREFIX, '').trim()
  while (ERROR_NAME_PREFIX.test(cleaned)) {
    cleaned = cleaned.replace(ERROR_NAME_PREFIX, '').trim()
  }
  return cleaned || FALLBACK_MESSAGE
}

export function describeIpcError(cause: unknown): Error {
  if (cause instanceof Error) return new Error(cleanIpcErrorMessage(cause.message))
  if (typeof cause === 'string') return new Error(cleanIpcErrorMessage(cause))
  return new Error(FALLBACK_MESSAGE)
}
