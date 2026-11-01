import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ThemePreference } from '@trade-request/shared';
import { useAuth } from './AuthContext';
import { updateThemePreference } from '../api/client';

interface ThemeState {
  preference: ThemePreference;
  resolved: 'light' | 'dark';
  setPreference: (pref: ThemePreference) => void;
  saveError?: boolean;
}

const ThemeContext = createContext<ThemeState>({
  preference: 'system',
  resolved: 'light',
  setPreference: () => {},
});

const STORAGE_KEY = 'theme-preference';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(r: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', r === 'dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  const initial = (): ThemePreference => {
    if (user?.themePreference && user.themePreference !== 'system') return user.themePreference;
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as ThemePreference | null;
      if (stored && ['light', 'dark', 'system'].includes(stored)) return stored;
    } catch {
      /* storage unavailable */
    }
    return user?.themePreference ?? 'system';
  };

  const [preference, setPreferenceState] = useState<ThemePreference>(initial);
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);

  const resolved = preference === 'system' ? systemTheme : preference;

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    if (user?.themePreference) {
      try {
        const stored = localStorage.getItem(STORAGE_KEY) as ThemePreference | null;
        if (!stored) {
          setPreferenceState(user.themePreference);
        }
      } catch {
        setPreferenceState(user.themePreference);
      }
    }
  }, [user?.themePreference]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setSystemTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const [saveError, setSaveError] = useState(false);

  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const themeMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      themeMountedRef.current = false;
      clearTimeout(errorTimerRef.current);
    };
  }, []);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* storage unavailable (e.g. Safari private mode) */
    }
    setSaveError(false);
    clearTimeout(errorTimerRef.current);
    updateThemePreference(pref).catch(() => {
      if (!themeMountedRef.current) return;
      setSaveError(true);
      errorTimerRef.current = setTimeout(() => {
        if (themeMountedRef.current) setSaveError(false);
      }, 3000);
    });
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, saveError }),
    [preference, resolved, setPreference, saveError],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
