/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { t, languages } from '../i18n'

const AppContext = createContext(null)
const themeModes = ['light', 'dark']

export const themeColors = [
  { code: 'blue', label: 'Blue', accent: '#2563eb', bright: '#14b8a6' },
  { code: 'red', label: 'Red', accent: '#e11d48', bright: '#f97316' },
  { code: 'purple', label: 'Purple', accent: '#7c3aed', bright: '#a855f7' },
  { code: 'pink', label: 'Pink', accent: '#db2777', bright: '#fb7185' },
  { code: 'teal', label: 'Teal', accent: '#0f766e', bright: '#22c55e' },
  { code: 'green', label: 'Green', accent: '#16a34a', bright: '#14b8a6' },
  { code: 'amber', label: 'Amber', accent: '#d97706', bright: '#f59e0b' },
]

const isThemeMode = mode => themeModes.includes(mode)
const isThemeColor = color => themeColors.some(c => c.code === color)

export function AppProvider({ children }) {
  const [lang,  setLangRaw]  = useState(() => localStorage.getItem('gty_lang') || 'en')
  const [theme, setThemeRaw] = useState(() => {
    const saved = localStorage.getItem('gty_theme')
    return isThemeMode(saved) ? saved : 'light'
  })
  const [themeColor, setThemeColorRaw] = useState(() => {
    const saved = localStorage.getItem('gty_theme_color')
    return isThemeColor(saved) ? saved : 'blue'
  })

  const setLang = useCallback(code => { setLangRaw(code); localStorage.setItem('gty_lang', code) }, [])
  const setTheme = useCallback(mode => {
    if (!isThemeMode(mode)) return
    setThemeRaw(mode)
    localStorage.setItem('gty_theme', mode)
  }, [])
  const setThemeColor = useCallback(color => {
    if (!isThemeColor(color)) return
    setThemeColorRaw(color)
    localStorage.setItem('gty_theme_color', color)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.setAttribute('data-color', themeColor)
    const lObj = languages.find(l => l.code === lang)
    document.documentElement.dir  = lObj?.dir || 'ltr'
    document.documentElement.lang = lang
  }, [lang, theme, themeColor])

  return (
    <AppContext.Provider value={{ lang, setLang, theme, setTheme, themeColor, setThemeColor, themeColors, tr: t[lang] || t.en, languages }}>
      {children}
    </AppContext.Provider>
  )
}

export const useAppContext = () => useContext(AppContext)
