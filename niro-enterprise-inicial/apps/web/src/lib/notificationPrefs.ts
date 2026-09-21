import { useCallback, useEffect, useState } from 'react';

export interface NotificationPrefs {
  soundMessages: boolean;   // sonido al llegar un mensaje
  soundTransfers: boolean;  // sonido al recibir una transferencia
  popups: boolean;          // avisos emergentes dentro del sistema
  desktop: boolean;         // avisos del navegador cuando la pestaña no está a la vista
  volume: number;           // 0.1 a 1
}

export const DEFAULT_PREFS: NotificationPrefs = { soundMessages: true, soundTransfers: true, popups: true, desktop: false, volume: 0.7 };

const key = (userId: string) => `niro_notif_prefs_${userId}`;

export function loadPrefs(userId: string): NotificationPrefs {
  try {
    const raw = localStorage.getItem(key(userId));
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch { return DEFAULT_PREFS; }
}

/** Preferencias de notificación por usuario (se guardan en este navegador). */
export function usePrefs(userId: string | undefined): [NotificationPrefs, (patch: Partial<NotificationPrefs>) => void] {
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => (userId ? loadPrefs(userId) : DEFAULT_PREFS));
  useEffect(() => { if (userId) setPrefs(loadPrefs(userId)); }, [userId]);
  const update = useCallback((patch: Partial<NotificationPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      if (userId) { try { localStorage.setItem(key(userId), JSON.stringify(next)); } catch { /* sin almacenamiento */ } }
      return next;
    });
  }, [userId]);
  return [prefs, update];
}
