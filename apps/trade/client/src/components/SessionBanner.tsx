import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Clock, AlertTriangle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { extendSession as extendSessionApi, fetchAppConfig } from '../api/client';

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const WARNING_THRESHOLD_MS = 5 * 60 * 1000;
const ANNOUNCE_THRESHOLDS_MS = [5 * 60_000, 60_000, 30_000];

export function SessionBanner() {
  const { user, logout } = useAuth();
  const sessionTtlRef = useRef(DEFAULT_SESSION_TTL_MS);
  const [expiresAt, setExpiresAt] = useState(() => Date.now() + DEFAULT_SESSION_TTL_MS);
  const [remaining, setRemaining] = useState(DEFAULT_SESSION_TTL_MS);
  const [extending, setExtending] = useState(false);
  const extendFailures = useRef(0);

  const [configError, setConfigError] = useState(false);
  const recoveringRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchAppConfig()
      .then((config) => {
        if (cancelled) return;
        if (config.sessionTtlMs > 0) {
          sessionTtlRef.current = config.sessionTtlMs;
          setExpiresAt(Date.now() + config.sessionTtlMs);
        }
        setConfigError(false);
      })
      .catch(() => {
        if (!cancelled) setConfigError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onActivity = () => {
      const newExpiry = Date.now() + sessionTtlRef.current;
      setExpiresAt(newExpiry);
      try {
        sessionChannel.current?.postMessage({ type: 'session-extend', expiresAt: newExpiry });
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('session-activity', onActivity);
    return () => window.removeEventListener('session-activity', onActivity);
  }, []);

  const sessionChannel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('session-sync');
    sessionChannel.current = ch;
    ch.onmessage = (e) => {
      if (e.data?.type === 'session-extend' && typeof e.data.expiresAt === 'number') {
        setExpiresAt(e.data.expiresAt);
      }
    };
    return () => ch.close();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const left = expiresAt - Date.now();
      setRemaining(left);
      if (left <= 0 && !recoveringRef.current) {
        clearInterval(interval);
        logout();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt, logout]);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;
      const left = expiresAt - Date.now();
      setRemaining(left);
      if (left <= 0) {
        recoveringRef.current = true;
        try {
          await extendSessionApi();
          extendFailures.current = 0;
          const newExpiry = Date.now() + sessionTtlRef.current;
          setExpiresAt(newExpiry);
          try {
            sessionChannel.current?.postMessage({ type: 'session-extend', expiresAt: newExpiry });
          } catch {
            /* ignore */
          }
        } catch {
          logout();
        } finally {
          recoveringRef.current = false;
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [expiresAt, logout]);

  const extendSession = useCallback(async () => {
    setExtending(true);
    try {
      await extendSessionApi();
      extendFailures.current = 0;
      setExpiresAt(Date.now() + sessionTtlRef.current);
    } catch {
      extendFailures.current += 1;
      if (extendFailures.current >= 3) {
        logout();
      }
    } finally {
      setExtending(false);
    }
  }, [logout]);

  const lastAnnouncedRef = useRef<number | null>(null);
  const [shouldAnnounce, setShouldAnnounce] = useState(false);

  useEffect(() => {
    const matched = ANNOUNCE_THRESHOLDS_MS.some((t) => {
      if (remaining <= t && (lastAnnouncedRef.current === null || lastAnnouncedRef.current > t)) {
        lastAnnouncedRef.current = t;
        return true;
      }
      return false;
    });
    if (matched) {
      setShouldAnnounce(true);
      const timer = setTimeout(() => setShouldAnnounce(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [remaining]);

  const showConfigWarning = useMemo(() => configError && remaining <= WARNING_THRESHOLD_MS, [configError, remaining]);

  if (!user || remaining > WARNING_THRESHOLD_MS) return null;

  const mins = Math.max(0, Math.floor(remaining / 60000));
  const secs = Math.max(0, Math.floor((remaining % 60000) / 1000));
  const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
  const isUrgent = remaining < 60_000;

  return (
    <div
      role="status"
      className={`w-full px-4 py-2 flex items-center justify-center gap-3 text-[13px] font-medium z-50 ${
        isUrgent
          ? 'bg-[var(--red-light)] text-[var(--red)] border-b border-[var(--red-border)]'
          : 'bg-[var(--yellow-light)] text-[var(--yellow)] border-b border-[var(--yellow-border)]'
      }`}
    >
      <Clock size={14} />
      <span>
        Your session expires in <span className="font-mono font-bold">{timeStr}</span>
      </span>
      {shouldAnnounce && (
        <span className="sr-only" role="alert" aria-live="assertive">
          Your session expires in {mins > 0 ? `${mins} minutes and ` : ''}
          {secs} seconds
        </span>
      )}
      {showConfigWarning && (
        <span className="flex items-center gap-1 text-[11px] opacity-75" title="Session timing may be approximate">
          <AlertTriangle size={11} />
          approx.
        </span>
      )}
      <button
        onClick={extendSession}
        disabled={extending}
        className={`px-3 py-1 rounded-md text-[12px] font-semibold transition-colors ${
          isUrgent
            ? 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50'
            : 'bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50'
        }`}
      >
        {extending ? 'Extending...' : 'Extend Session'}
      </button>
    </div>
  );
}
