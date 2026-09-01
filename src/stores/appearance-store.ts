import { createStore } from 'zustand/vanilla'
import {
  loadAppearance,
  saveAppearance,
  type Accent,
  type Appearance,
  type Theme
} from './appearance-persistence'
import { getBrowserStorage, type StorageLike } from './settings-persistence'

export interface AppearanceState extends Appearance {
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setAccent: (accent: Accent) => void
}

/**
 * Theme and accent, written through to storage on every change. Kept out of App's
 * component state so the settings panel in either view can set it without either
 * view owning it.
 */
export function createAppearanceStore(storage: StorageLike | null = getBrowserStorage()) {
  return createStore<AppearanceState>((set, get) => {
    const setAndPersist = (changes: Partial<Appearance>) => set((state) => {
      saveAppearance(storage, { theme: state.theme, accent: state.accent, ...changes })
      return changes
    })

    return {
      ...loadAppearance(storage),
      setTheme: (theme) => setAndPersist({ theme }),
      toggleTheme: () => setAndPersist({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      setAccent: (accent) => setAndPersist({ accent })
    }
  })
}

export const appearanceStore = createAppearanceStore()
