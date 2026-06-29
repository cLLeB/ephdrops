import React, { createContext, useContext, useEffect, useState } from 'react';

const ThemeContext = createContext();

function resolveEffective(theme) {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

export const ThemeProvider = ({ children }) => {
  const [theme, setThemeRaw] = useState(() => {
    if (typeof window === 'undefined') return 'light';
    return localStorage.getItem('theme') || 'system';
  });

  // Effective theme is what actually gets applied (dark or light)
  const [effective, setEffective] = useState(() => resolveEffective(
    localStorage.getItem('theme') || 'system'
  ));

  const applyEffective = (eff) => {
    const root = window.document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (eff === 'dark') {
      root.classList.add('dark');
      meta?.setAttribute('content', '#030712');
    } else {
      root.classList.remove('dark');
      meta?.setAttribute('content', '#e8edf2');
    }
  };

  // Apply whenever effective theme changes
  useEffect(() => {
    applyEffective(effective);
  }, [effective]);

  // Listen for OS theme changes when in 'system' mode
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (theme === 'system') {
        setEffective(mq.matches ? 'dark' : 'light');
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = (next) => {
    setThemeRaw(next);
    localStorage.setItem('theme', next);
    setEffective(resolveEffective(next));
  };

  // Cycle: light → dark → system
  const toggleTheme = () => {
    setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light');
  };

  return (
    <ThemeContext.Provider value={{ theme, effective, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
};
