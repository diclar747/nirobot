import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuth } from './AuthContext';
import { installSoundUnlock, playMessageSound, playTransferSound } from '../lib/sounds';
import { usePrefs, type NotificationPrefs } from '../lib/notificationPrefs';
import type { Conversation, Message } from '../types';

export interface AppNotification {
  id: string;
  type: 'message' | 'transfer';
  title: string;
  body: string;
  conversationId: string;
  at: number;
  read: boolean;
}
export interface Toast { id: string; notification: AppNotification }

interface Ctx {
  items: AppNotification[];
  unread: number;
  toasts: Toast[];
  prefs: NotificationPrefs;
  updatePrefs: (patch: Partial<NotificationPrefs>) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  clearAll: () => void;
  open: (n: AppNotification) => void;
  dismissToast: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
}

const NotificationsContext = createContext<Ctx | null>(null);
const MAX_ITEMS = 40;

function contactLabel(c: Conversation['contact']) { return c.name?.trim() || c.phone || 'Cliente'; }
function preview(m: Message) {
  const text = (m.content || '').replace(/\s+/g, ' ').trim();
  if (m.attachment && (!text || /^[^\wáéíóú]*\s?(Imagen|Audio|Video|Documento|Sticker)$/i.test(text))) {
    const mime = m.attachment.mimeType;
    return mime.startsWith('audio/') ? 'Nota de voz' : mime.startsWith('image/') ? 'Foto' : mime.startsWith('video/') ? 'Video' : 'Archivo';
  }
  return text.length > 110 ? `${text.slice(0, 110)}…` : text || 'Nuevo mensaje';
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const userId = user?.id;
  const enabled = Boolean(user && user.role !== 'SUPERADMIN');
  const [prefs, updatePrefs] = usePrefs(userId);
  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);

  const storageKey = userId ? `niro_notifications_${userId}` : null;
  const [items, setItems] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const activeConversation = useRef<string | null>(null);
  const conversationCache = useRef(new Map<string, { at: number; conversation: Conversation | null }>());
  const baseTitle = useRef(typeof document !== 'undefined' ? document.title : 'Niro');

  useEffect(() => { installSoundUnlock(); }, []);

  useEffect(() => {
    if (!storageKey) return;
    try { setItems(JSON.parse(sessionStorage.getItem(storageKey) || '[]')); } catch { setItems([]); }
  }, [storageKey]);
  useEffect(() => {
    if (!storageKey) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(items.slice(0, MAX_ITEMS))); } catch { /* sin almacenamiento */ }
  }, [items, storageKey]);

  const unread = items.filter((n) => !n.read).length;

  // Contador en el título de la pestaña: "(2) Niro…"
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (!document.title.replace(/^\(\d+\)\s*/, '').trim()) return;
    baseTitle.current = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = unread > 0 ? `(${unread}) ${baseTitle.current}` : baseTitle.current;
  }, [unread]);

  const push = useCallback((n: Omit<AppNotification, 'id' | 'at' | 'read'>) => {
    const notification: AppNotification = { ...n, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), read: false };
    setItems((cur) => [notification, ...cur].slice(0, MAX_ITEMS));
    const p = prefsRef.current;
    if (n.type === 'transfer' ? p.soundTransfers : p.soundMessages) (n.type === 'transfer' ? playTransferSound : playMessageSound)(p.volume);
    if (p.popups) {
      const toast = { id: notification.id, notification };
      setToasts((cur) => [toast, ...cur].slice(0, 3));
      window.setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== toast.id)), n.type === 'transfer' ? 15000 : 6500);
    }
    if (p.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      try {
        const desktop = new Notification(n.title, { body: n.body, tag: `niro-${n.conversationId}`, icon: '/favicon.ico' });
        desktop.onclick = () => { window.focus(); navigate(`/inbox?conversation=${n.conversationId}`); desktop.close(); };
      } catch { /* el navegador no permite avisos */ }
    }
  }, [navigate]);

  const fetchConversation = useCallback(async (id: string) => {
    const cached = conversationCache.current.get(id);
    if (cached && Date.now() - cached.at < 60000) return cached.conversation;
    try {
      const data = await apiGet<{ conversation: Conversation }>(`/api/org/conversations/${id}`);
      conversationCache.current.set(id, { at: Date.now(), conversation: data.conversation });
      return data.conversation;
    } catch {
      conversationCache.current.set(id, { at: Date.now(), conversation: null }); // sin acceso a ese chat: no se avisa
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !userId) return;
    const socket = getSocket();

    const onTransfer = ({ conversation, fromAgent, note }: { conversation: Conversation; fromAgent: string; note: string | null }) => {
      conversationCache.current.delete(conversation.id);
      push({ type: 'transfer', conversationId: conversation.id, title: `${fromAgent} te transfirió un chat`, body: `${contactLabel(conversation.contact)}${note ? ` — ${note}` : ''}` });
    };

    const onMessage = async ({ conversationId, message }: { conversationId: string; message: Message }) => {
      if (message.direction !== 'INBOUND') return;
      const watching = activeConversation.current === conversationId && document.hasFocus() && !document.hidden;
      if (watching) return;
      const conversation = await fetchConversation(conversationId);
      if (!conversation) return;
      // Avisamos si el chat es mío o todavía no tiene dueño; si lo atiende otra persona, no molestamos.
      if (conversation.assignedTo && conversation.assignedTo.id !== userId) return;
      push({ type: 'message', conversationId, title: contactLabel(conversation.contact), body: preview(message) });
    };

    const onConversationUpdated = ({ conversation }: { conversation: Conversation }) => { conversationCache.current.set(conversation.id, { at: Date.now(), conversation }); };

    socket.on('transfer:incoming', onTransfer);
    socket.on('message:new', onMessage);
    socket.on('conversation:updated', onConversationUpdated);
    return () => { socket.off('transfer:incoming', onTransfer); socket.off('message:new', onMessage); socket.off('conversation:updated', onConversationUpdated); };
  }, [enabled, userId, push, fetchConversation]);

  const markRead = useCallback((id: string) => setItems((cur) => cur.map((n) => (n.id === id ? { ...n, read: true } : n))), []);
  const markAllRead = useCallback(() => setItems((cur) => cur.map((n) => ({ ...n, read: true }))), []);
  const clearAll = useCallback(() => { setItems([]); setToasts([]); }, []);
  const dismissToast = useCallback((id: string) => setToasts((cur) => cur.filter((t) => t.id !== id)), []);
  const open = useCallback((n: AppNotification) => { markRead(n.id); dismissToast(n.id); navigate(`/inbox?conversation=${n.conversationId}`); }, [markRead, dismissToast, navigate]);
  const setActiveConversation = useCallback((id: string | null) => {
    activeConversation.current = id;
    if (id) setItems((cur) => (cur.some((n) => n.conversationId === id && !n.read) ? cur.map((n) => (n.conversationId === id ? { ...n, read: true } : n)) : cur));
  }, []);

  const value = useMemo<Ctx>(() => ({ items, unread, toasts, prefs, updatePrefs, markAllRead, markRead, clearAll, open, dismissToast, setActiveConversation }),
    [items, unread, toasts, prefs, updatePrefs, markAllRead, markRead, clearAll, open, dismissToast, setActiveConversation]);
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): Ctx {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications debe usarse dentro de NotificationsProvider');
  return ctx;
}
