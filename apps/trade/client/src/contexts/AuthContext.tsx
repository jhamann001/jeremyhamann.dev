import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { AuthUser, UserRole } from '@trade-request/shared';
import { fetchCurrentUser, logout as apiLogout, toggleDemo as apiToggleDemo, extractApiError } from '../api/client';

const ROLE_OVERRIDE_KEY = 'demo_role_override';

interface AuthState {
  /** User with the effective role (overridden when demo mode is active). */
  user: AuthUser | null;
  /** The real authenticated user, unaffected by demo overrides. */
  actualUser: AuthUser | null;
  loading: boolean;
  error: string | null;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  roleOverride: UserRole | null;
  setRoleOverride: (role: UserRole | null) => void;
  isDemo: boolean;
  canDemo: boolean;
  toggleDemo: () => Promise<void>;
  /** The demo's outbox of undelivered Slack messages and emails is available. */
  hasOutbox: boolean;
}

const AuthContext = createContext<AuthState>({
  user: null,
  actualUser: null,
  loading: true,
  error: null,
  logout: async () => {},
  refresh: async () => {},
  roleOverride: null,
  setRoleOverride: () => {},
  isDemo: false,
  canDemo: false,
  toggleDemo: async () => {},
  hasOutbox: false,
});

function readStoredOverride(): UserRole | null {
  if (!import.meta.env.DEV) return null;
  try {
    const v = sessionStorage.getItem(ROLE_OVERRIDE_KEY);
    if (v === 'advisor' || v === 'trader') return v;
  } catch {
    /* SSR / blocked storage */
  }
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [actualUser, setActualUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roleOverride, setRoleOverrideRaw] = useState<UserRole | null>(readStoredOverride);
  const [isDemo, setIsDemo] = useState(false);
  const [canDemo, setCanDemo] = useState(false);
  const [hasOutbox, setHasOutbox] = useState(false);

  const setRoleOverride = useCallback(
    (role: UserRole | null) => {
      if (!import.meta.env.DEV && !isDemo) return;
      setRoleOverrideRaw(role);
      try {
        if (role) sessionStorage.setItem(ROLE_OVERRIDE_KEY, role);
        else sessionStorage.removeItem(ROLE_OVERRIDE_KEY);
      } catch {
        /* blocked storage */
      }
    },
    [isDemo],
  );

  const user = useMemo(() => {
    if (!actualUser) return null;
    if ((!import.meta.env.DEV && !isDemo) || !roleOverride || roleOverride === actualUser.role) return actualUser;
    return { ...actualUser, role: roleOverride };
  }, [actualUser, roleOverride, isDemo]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const u = await fetchCurrentUser();
      if (!mountedRef.current) return;
      if (u) {
        const extended = u as AuthUser & { demo?: boolean; canDemo?: boolean; outbox?: boolean };
        setIsDemo(extended.demo ?? false);
        setCanDemo(extended.canDemo ?? false);
        setHasOutbox(extended.outbox ?? false);
      }
      setActualUser(u);
    } catch (err) {
      if (!mountedRef.current) return;
      setActualUser(null);
      setError(extractApiError(err, 'Unable to reach the server'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleDemo = useCallback(async () => {
    try {
      const result = await apiToggleDemo();
      setIsDemo(result.demo);
      if (!result.demo) setRoleOverride(null);
    } catch {
      /* toggle failed — ignore */
    }
  }, [setRoleOverride]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // Server may be unreachable — still clear local state
    } finally {
      setActualUser(null);
      setRoleOverride(null);
      setIsDemo(false);
      window.location.href = '/login';
    }
  }, [setRoleOverride]);

  return (
    <AuthContext.Provider
      value={{
        user,
        actualUser,
        loading,
        error,
        logout,
        refresh,
        roleOverride,
        setRoleOverride,
        isDemo,
        canDemo,
        toggleDemo,
        hasOutbox,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
