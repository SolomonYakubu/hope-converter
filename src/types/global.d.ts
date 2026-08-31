import type { HopeConverterApi } from './hope-converter'

declare global {
  interface Window {
    hopeConverter: HopeConverterApi
  }
}

export {}
