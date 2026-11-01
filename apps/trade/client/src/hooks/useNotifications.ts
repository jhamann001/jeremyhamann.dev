import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Notification } from '@trade-request/shared';
import { fetchNotifications, markNotificationRead, markAllNotificationsRead } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

const EPHEMERAL_PREFIX = 'ephemeral-';

export function useNotifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [serverUnread, setServerUnread] = useState(0);
  const [ephemeral, setEphemeral] = useState<Notification[]>([]);
  const loadInFlightRef = useRef(false);
  const { isDemo } = useAuth();

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    try {
      const { data, unreadCount } = await fetchNotifications({ limit: 100 });
      setItems(data);
      setServerUnread(unreadCount);
    } catch {
      /* keep previous */
    } finally {
      loadInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, isDemo]);

  useEffect(() => {
    const id = setInterval(() => {
      load();
    }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const onActivity = () => {
      load();
    };
    window.addEventListener('session-activity', onActivity);
    return () => window.removeEventListener('session-activity', onActivity);
  }, [load]);

  const pushEphemeral = useCallback((message: string) => {
    const n: Notification = {
      id: `${EPHEMERAL_PREFIX}${crypto.randomUUID()}`,
      message,
      isRead: false,
      date: new Date().toISOString(),
    };
    setEphemeral((prev) => [n, ...prev]);
  }, []);

  const notifications = useMemo(() => [...ephemeral, ...items], [ephemeral, items]);

  const unreadCount = serverUnread + ephemeral.length;

  const markRead = useCallback(
    async (id: string) => {
      if (id.startsWith(EPHEMERAL_PREFIX)) {
        setEphemeral((prev) => prev.filter((n) => n.id !== id));
        return;
      }
      try {
        await markNotificationRead(id);
        await load();
      } catch {
        /* ignore */
      }
    },
    [load],
  );

  const markAllRead = useCallback(async () => {
    setEphemeral([]);
    try {
      await markAllNotificationsRead();
      await load();
    } catch {
      /* ignore */
    }
  }, [load]);

  return { notifications, unreadCount, markRead, markAllRead, refresh: load, pushEphemeral };
}
