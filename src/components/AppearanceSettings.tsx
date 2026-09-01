import type { CSSProperties } from 'react'
import { useStore } from 'zustand'
import { Check, Moon, Sun } from 'lucide-react'
import { appearanceStore } from '../stores/appearance-store'
import { ACCENT_OPTIONS, type Theme } from '../stores/appearance-persistence'

const THEME_OPTIONS: readonly { value: Theme; label: string; Icon: typeof Moon }[] = [
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'light', label: 'Light', Icon: Sun }
]

/**
 * The Appearance group of the settings dialog: the theme pair, then the accent swatches.
 * It reads the appearance store directly rather than taking props, because nothing above
 * it in the dialog has any other reason to know what the theme is.
 *
 * The swatches paint accents that are not the selected one, so they cannot use --fill:
 * each takes its colour from the accent's headline tokens in :root through two inline
 * custom properties. That is also why those tokens are declared outside the accent
 * blocks in src/styles.css.
 */
export function AppearanceSettings() {
  const theme = useStore(appearanceStore, (state) => state.theme)
  const accent = useStore(appearanceStore, (state) => state.accent)

  return (
    <div className="setting-group">
      <span className="field-label" id="appearance-label">Appearance</span>
      <div className="preset-group theme-choice" role="group" aria-labelledby="appearance-label">
        {THEME_OPTIONS.map(({ value, label, Icon }) => (
          <button key={value} type="button" aria-pressed={theme === value}
            className={`quality-option ${theme === value ? 'selected' : ''}`}
            onClick={() => appearanceStore.getState().setTheme(value)}>
            <span><Icon size={14} aria-hidden="true" />{label}</span>
          </button>
        ))}
      </div>
      <div className="accent-row" role="group" aria-label="Accent colour">
        {ACCENT_OPTIONS.map((option) => (
          <button key={option.value} type="button" title={option.label}
            aria-pressed={accent === option.value} aria-label={option.label}
            className={`accent-swatch ${accent === option.value ? 'selected' : ''}`}
            style={{
              '--swatch': `var(--accent-${option.value})`,
              '--swatch-glint': `var(--accent-${option.value}-glint)`
            } as CSSProperties}
            onClick={() => appearanceStore.getState().setAccent(option.value)}>
            {accent === option.value && <Check size={15} aria-hidden="true" />}
          </button>
        ))}
      </div>
      <p className="setting-note">
        An accent re-tints the whole palette — the mark above included — rather than only
        the buttons. Each one is generated from the violet by hue, then every colour that
        carries text is moved until it reaches the contrast the violet does, so the labels
        stay as legible.
      </p>
    </div>
  )
}
