import React, { createContext, useContext, useEffect, useState } from 'react';

export type AppTheme = 'blue' | 'dark' | 'emerald' | 'sunset' | 'graphite' | 'light';

/** Plantillas de color disponibles. En las oscuras el texto siempre va claro; cambia el color de fondos y acentos. */
export const APP_THEMES: { id: AppTheme; label: string; hint: string; swatch: string }[] = [
  { id: 'blue', label: 'Azul', hint: 'Oscuro', swatch: 'linear-gradient(135deg, #0284c7, #2563eb)' },
  { id: 'dark', label: 'Violeta', hint: 'Oscuro', swatch: 'linear-gradient(135deg, #9333ea, #d946ef)' },
  { id: 'emerald', label: 'Verde', hint: 'Oscuro', swatch: 'linear-gradient(135deg, #059669, #0d9488)' },
  { id: 'sunset', label: 'Naranja', hint: 'Oscuro', swatch: 'linear-gradient(135deg, #ea580c, #e11d48)' },
  { id: 'graphite', label: 'Grafito', hint: 'Oscuro', swatch: 'linear-gradient(135deg, #475569, #94a3b8)' },
  { id: 'light', label: 'Claro', hint: 'Fondo blanco', swatch: 'linear-gradient(135deg, #e2e8f0, #ffffff)' }
];

interface ThemeContextType {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'blue',
  setTheme: () => {}
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<AppTheme>(() => {
    const saved = localStorage.getItem('niro_app_theme') as AppTheme;
    return APP_THEMES.some((option) => option.id === saved) ? saved : 'blue';
  });

  const setTheme = (newTheme: AppTheme) => {
    setThemeState(newTheme);
    localStorage.setItem('niro_app_theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
