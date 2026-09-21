import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, apiUpload, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { CallAudio } from '../lib/callAudio';
import { contactLabel, formatPhone, formatTime, initials, isUsablePhone, phoneDigits } from '../lib/format';
import { CRM_STAGES, deriveStage, statusForStage, tagsForStage, type CrmStage } from '../lib/crmStage';
import { Modal } from '../components/Modal';
import { PlyrVideo, WaveAudio } from '../components/MediaPlayers';
import { Ui, type UiIconName } from '../components/Ui';
import { EmojiPicker } from '../components/EmojiPicker';
import { QuickReplyManager, QuickReplyPopover, useQuickReplies } from '../components/QuickReplies';
import { detectSlash, fillTemplate, rankReplies, type QuickReply } from '../lib/quickReplies';
import { can } from '../lib/permissions';
import { useNotifications } from '../context/NotificationsContext';
import { useLocation, useNavigate } from 'react-router-dom';
import { StatusStories } from '../components/StatusStories';
import { AgentsDropPanel, setConversationDragData } from '../components/AgentsDropPanel';
import { useAlerts } from '../context/AlertContext';
import { useAuth } from '../context/AuthContext';
import { useOutcome } from '../context/OutcomeContext';
import { RichText } from '../components/RichText';
import { PRESENCE_COLOR, PRESENCE_LABEL } from '../lib/presence';
import {
  type AgentPresence,
  type AgentPresenceStatus,
  type Contact,
  type Conversation,
  type Department,
  type Message,
  type OrgUser
} from '../types';

type ConvFilterTab = 'all' | 'clients' | 'internal';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// Agrupa las reacciones por emoji: "❤️ 2" en vez de dos chips iguales. La propia siempre puede quitarse.
function groupReactions(mine: string | null, others: Array<{ emoji: string; from: string }>) {
  const groups = new Map<string, { emoji: string; count: number; mine: boolean; who: string[] }>();
  const add = (emoji: string, isMine: boolean, who: string) => {
    const g = groups.get(emoji) || { emoji, count: 0, mine: false, who: [] };
    g.count += 1; g.mine = g.mine || isMine; g.who.push(who);
    groups.set(emoji, g);
  };
  if (mine) add(mine, true, 'vos');
  others.forEach((r) => add(r.emoji, false, r.from === 'customer' ? 'el cliente' : 'un agente'));
  return Array.from(groups.values()).map((g) => ({ ...g, title: `Reacción de ${g.who.join(' y ')}` }));
}
const DIRECT_CALL_ACTIVE_STATUSES = new Set(['STARTING', 'RINGING', 'CONNECTED']);

type DirectCall = {
  id: string;
  callId: string;
  audioToken?: string;
  phoneNumber: string;
  accountId: string;
  status: 'STARTING' | 'RINGING' | 'CONNECTED' | 'COMPLETED' | 'NO_ANSWER' | 'FAILED' | 'CANCELLED';
  startedAt: string;
  connectedAt: string | null;
  finishedAt: string | null;
  endedReason: string | null;
};

function directCallStatusLabel(status: DirectCall['status'], endedReason?: string | null) {
  const labels: Record<DirectCall['status'], string> = {
    STARTING: 'Iniciando llamada…',
    RINGING: 'Llamando…',
    CONNECTED: 'Llamada conectada',
    COMPLETED: 'Llamada finalizada',
    NO_ANSWER: 'Sin respuesta (no contestó o cortó antes de atender)',
    FAILED: 'Llamada fallida',
    CANCELLED: 'Llamada cancelada'
  };
  if (status === 'FAILED') {
    if (endedReason === 'media_timeout' || endedReason === 'media_disconnected') return 'Llamada finalizada: no se recibió el audio del micrófono (revisá el permiso del navegador)';
    if (endedReason === 'connection_lost' || endedReason === 'disconnect') return 'Llamada finalizada: se perdió la conexión';
  }
  return labels[status];
}

function Avatar({ contact, size = 42 }: { contact: Contact; size?: number }) {
  const label = contactLabel(contact);
  if (contact.avatarUrl) {
    return (
      <img
        src={contact.avatarUrl}
        alt={label}
        className="crm-conv-avatar"
        style={{ width: size, height: size, objectFit: 'cover' }}
      />
    );
  }
  return (
    <div className="crm-conv-avatar" style={{ width: size, height: size }}>
      {initials(label)}
    </div>
  );
}

function StageBadge({ conversation }: { conversation: Conversation }) {
  const stage = CRM_STAGES.find((s) => s.key === deriveStage(conversation))!;
  return (
    <span className="crm-stage-badge" style={{ background: stage.color }}>
      {stage.label}
    </span>
  );
}

export function Inbox() {
  const navigate = useNavigate();
  function openConversation(id: string) {
    setSelectedId(id);
    setMobileInfo(false);
    navigate(`/inbox?conversation=${encodeURIComponent(id)}`);
  }
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [tab, setTab] = useState<ConvFilterTab>('all');
  const [search, setSearch] = useState('');
  // Abre directo la conversación indicada por ?conversation=<id> — así llega el clic en una
  // notificación push o cualquier otro enlace directo al Inbox.
  const [selectedId, setSelectedId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('conversation')
  );
  const [mobileInfo, setMobileInfo] = useState(false);
  const drafts = useRef(new Map<string, { text: string; mode: 'outbound' | 'note' | 'inbound' }>());
  const [showNew, setShowNew] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [forwardMessage, setForwardMessage] = useState<Message | null>(null);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const { notify } = useAlerts();
  const [starredIds, setStarredIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('niro_starred_messages');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(() => window.matchMedia('(max-width: 1200px)').matches);
  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 860px)');
    const resetPanels = () => { if (mobile.matches) { setLeftCollapsed(false); setRightCollapsed(true); setMobileInfo(false); } };
    mobile.addEventListener('change', resetPanels);
    return () => mobile.removeEventListener('change', resetPanels);
  }, []);
  const [lightboxImage, setLightboxImage] = useState<{ url: string; fileName: string } | null>(null);
  const [incomingTransfer, setIncomingTransfer] = useState<{ conversation: Conversation; fromAgent: string; note: string | null } | null>(null);
  const [respondingTransfer, setRespondingTransfer] = useState(false);

  const showToast = useCallback((msg: string) => notify(msg, { tone: 'info' }), [notify]);

  function toggleStarMessage(msgId: string) {
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
        showToast('Mensaje quitado de destacados');
      } else {
        next.add(msgId);
        showToast('Mensaje guardado en destacados');
      }
      try {
        localStorage.setItem('niro_starred_messages', JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }

  const upsertConversation = useCallback((conversation: Conversation) => {
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conversation.id);
      const merged: Conversation = idx === -1 ? conversation : { ...conversation, unreadCount: conversation.unreadCount ?? prev[idx].unreadCount, lastMessage: conversation.lastMessage ?? prev[idx].lastMessage };
      const next = idx === -1 ? [merged, ...prev] : prev.map((c) => (c.id === conversation.id ? merged : c));
      return [...next].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    });
  }, []);

  const loadConversations = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      const data = await apiGet<{ conversations: Conversation[] }>(`/api/org/conversations?${params.toString()}`);
      setConversations(data.conversations);
      if (data.conversations.length > 0 && !selectedId && !window.matchMedia('(max-width: 860px)').matches) {
        setSelectedId(data.conversations[0].id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar las conversaciones');
    } finally {
      setLoadingList(false);
    }
  }, [search, selectedId]);

  useEffect(() => {
    const id = setTimeout(loadConversations, search ? 300 : 0);
    return () => clearTimeout(id);
  }, [loadConversations, search]);

  // --- No leídos ---
  const selectedIdRef = useRef<string | null>(null);
  const markConversationRead = useCallback((id: string) => {
    setConversations((prev) => (prev.some((c) => c.id === id && (c.unreadCount || 0) > 0) ? prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)) : prev));
    apiPost(`/api/org/conversations/${id}/read`).catch(() => {});
  }, []);

  useEffect(() => {
    const socket = getSocket();
    const onMessageNew = ({ conversationId, message }: { conversationId: string; message: Message }) => {
      if (message.direction === 'NOTE') return;
      const watching = selectedIdRef.current === conversationId && document.hasFocus() && !document.hidden;
      if (message.direction === 'INBOUND' && watching) { markConversationRead(conversationId); }
      setConversations((prev) => {
        if (!prev.some((c) => c.id === conversationId)) return prev; // chat nuevo: lo trae conversation:new
        const next = prev.map((c) => (c.id === conversationId ? {
          ...c,
          updatedAt: message.createdAt,
          unreadCount: message.direction === 'INBOUND' && !watching ? (c.unreadCount || 0) + 1 : c.unreadCount || 0,
          lastMessage: { content: (message.content || '').slice(0, 120), direction: message.direction, contentType: message.contentType, at: message.createdAt }
        } : c));
        return [...next].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      });
    };
    const onRead = ({ conversationId }: { conversationId: string }) => setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)));
    socket.on('message:new', onMessageNew);
    socket.on('conversation:read', onRead);
    return () => { socket.off('message:new', onMessageNew); socket.off('conversation:read', onRead); };
  }, [markConversationRead]);

  useEffect(() => {
    const socket = getSocket();
    const onNew = ({ conversation }: { conversation: Conversation }) => upsertConversation(conversation);
    const onUpdated = ({ conversation }: { conversation: Conversation }) => upsertConversation(conversation);
    const onTransferIncoming = (payload: { conversation: Conversation; fromAgent: string; note: string | null }) => {
      upsertConversation(payload.conversation);
      setIncomingTransfer(payload);
    };
    socket.on('conversation:new', onNew);
    // Dejó de ser visible para mí (p. ej. se la transfirieron a otro agente): sale de la lista.
    const onHidden = ({ conversationId }: { conversationId: string }) => {
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      setSelectedId((current) => (current === conversationId ? null : current));
    };
    socket.on('conversation:hidden', onHidden);
    socket.on('conversation:updated', onUpdated);
    socket.on('transfer:incoming', onTransferIncoming);
    return () => {
      socket.off('conversation:new', onNew);
      socket.off('conversation:hidden', onHidden);
      socket.off('conversation:updated', onUpdated);
      socket.off('transfer:incoming', onTransferIncoming);
    };
  }, [upsertConversation]);

  async function respondToTransfer(action: 'accept' | 'reject') {
    if (!incomingTransfer) return;
    setRespondingTransfer(true);
    try {
      const res = await apiPost<{ conversation: Conversation }>(
        `/api/org/conversations/${incomingTransfer.conversation.id}/transfer-response`,
        { action }
      );
      upsertConversation(res.conversation);
      if (action === 'accept') openConversation(res.conversation.id);
      setIncomingTransfer(null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'No se pudo responder a la transferencia. Volvé a intentar.', { tone: 'error' });
    } finally {
      setRespondingTransfer(false);
    }
  }

  const filteredConversations = conversations.filter((c) => {
    if (tab === 'clients') return c.channel !== 'internal';
    if (tab === 'internal') return c.channel === 'internal';
    return true;
  });

  const selected = filteredConversations.find((c) => c.id === selectedId) || filteredConversations[0] || null;

  // Abrir un chat lo marca como leído (y también al volver a esta pestaña con el chat abierto).
  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    if (!selected) return;
    if (document.hasFocus() && !document.hidden) markConversationRead(selected.id);
    const onFocus = () => markConversationRead(selected.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [selected?.id, markConversationRead]);

  // Le avisamos al centro de notificaciones qué chat estoy mirando (para no notificar lo que ya veo).
  const { setActiveConversation } = useNotifications();
  useEffect(() => {
    setActiveConversation(selected?.id ?? null);
    return () => setActiveConversation(null);
  }, [selected?.id, setActiveConversation]);

  // Clic en una notificación (o enlace ?conversation=…) estando ya en el inbox: abre ese chat.
  const location = useLocation();
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('conversation');
    if (id) setSelectedId(id);
    else if (window.matchMedia('(max-width: 860px)').matches) setSelectedId(null);
  }, [location.key, location.search]);

  const gridTemplate = leftCollapsed
    ? rightCollapsed
      ? '72px 1fr 56px'
      : '72px 1fr 340px'
    : rightCollapsed
    ? '320px 1fr 56px'
    : '320px 1fr 340px';

  return (
    <div className={`crm-inbox-grid ${selectedId ? 'mobile-chat-open' : 'mobile-list-open'} ${mobileInfo ? 'mobile-info-open' : ''}`} style={{ gridTemplateColumns: gridTemplate }}>
      {/* =========================================================
          COLUMN 1: CONVERSATIONS LIST
          ========================================================= */}
      {!leftCollapsed && (
        <div className="crm-conv-column">
          <div className="crm-conv-header">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text-main)' }}>Conversaciones</h2>
                <button
                  type="button"
                  onClick={() => setLeftCollapsed(true)}
                  title="Minimizar lista de conversaciones"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-dim)',
                    fontSize: 13,
                    padding: '2px 6px'
                  }}
                >
                  <Ui name="chevron-left" size={16} />
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn small"
                  style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={() => setShowNew(true)}
                >
                  + Nuevo
                </button>
              </div>
            </div>

            <div className="crm-conv-tabs">
              <button
                type="button"
                className={`crm-conv-tab-btn ${tab === 'all' ? 'active' : ''}`}
                onClick={() => setTab('all')}
              >
                Todas {conversations.length > 0 && `(${conversations.length})`}
              </button>
              <button
                type="button"
                className={`crm-conv-tab-btn ${tab === 'clients' ? 'active' : ''}`}
                onClick={() => setTab('clients')}
              >
                Clientes
              </button>
              <button
                type="button"
                className={`crm-conv-tab-btn ${tab === 'internal' ? 'active' : ''}`}
                onClick={() => setTab('internal')}
              >
                Internas
              </button>
            </div>

            <div style={{ position: 'relative' }}>
              <input
                className="topbar-search-input"
                style={{ background: 'var(--bg-surface-2)', padding: '8px 14px 8px 34px', fontSize: 12.5 }}
                placeholder="Buscar por nombre, teléfono..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', opacity: 0.5, display: 'flex' }}>
                <Ui name="search" size={15} />
              </span>
            </div>
          </div>

          <StatusStories />

          <div className="crm-conv-list-items">
            {loadingList && <p style={{ padding: 16, color: 'var(--text-dim)', fontSize: 13 }}>Cargando...</p>}
            {!loadingList && error && (
              <p style={{ padding: 16, color: 'var(--danger)', fontSize: 13 }}>{error}</p>
            )}
            {!loadingList && !error && filteredConversations.length === 0 && (
              <p style={{ padding: 16, color: 'var(--text-dim)', fontSize: 13 }}>No hay conversaciones registradas.</p>
            )}

            {filteredConversations.map((c) => {
              const isSelected = selected?.id === c.id;
              return (
                <div
                  key={c.id}
                  className={`crm-conv-item ${isSelected ? 'active' : ''} ${(c.unreadCount || 0) > 0 ? 'unread' : ''}`}
                  onClick={() => openConversation(c.id)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Abrir conversación con ${contactLabel(c.contact)}`}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openConversation(c.id); } }}
                  draggable
                  onDragStart={(e) => setConversationDragData(e, c.id)}
                >
                  <div className="crm-conv-avatar-box">
                    <Avatar contact={c.contact} />
                  </div>

                  <div className="crm-conv-content">
                    <div className="crm-conv-name-row">
                      <span className="crm-conv-name">{contactLabel(c.contact)}</span>
                      <span className="crm-conv-time">{formatTime(c.updatedAt)}</span>
                    </div>

                    <div className="crm-conv-preview" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {c.contact.phone ? (
                        <span style={{ color: 'var(--primary-glow)', fontWeight: 600, fontSize: 11.5 }}>
                          <Ui name="phone" size={12} /> {formatPhone(c.contact.phone)}
                        </span>
                      ) : null}
                      <span className="crm-conv-lastmsg">
                        {c.lastMessage ? `${c.lastMessage.direction === 'OUTBOUND' ? 'Tú: ' : ''}${c.lastMessage.content || 'Adjunto'}` : c.subject || 'Sin mensajes todavía'}
                      </span>
                    </div>

                    <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <StageBadge conversation={c} />
                      {(c.unreadCount || 0) > 0 && <span className="crm-unread-pill" title={`${c.unreadCount} mensaje(s) sin leer`}>{(c.unreadCount || 0) > 99 ? '99+' : c.unreadCount}</span>}
                      {c.assignedTo && (
                        <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                          <Ui name="user" size={12} /> {c.assignedTo.name.split(' ')[0]}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {leftCollapsed && (
        <aside className="crm-conv-rail" aria-label="Conversaciones minimizadas">
          <button type="button" className="crm-conv-rail-btn" onClick={() => setLeftCollapsed(false)} title="Mostrar lista de conversaciones" aria-label="Mostrar lista de conversaciones"><Ui name="chevron-right" size={18} /></button>
          <button type="button" className="crm-conv-rail-btn accent" onClick={() => setShowNew(true)} title="Nueva conversación" aria-label="Nueva conversación"><Ui name="plus" size={20} /></button>
          <div className="crm-conv-rail-tabs">
            {([['all', 'chat', 'Todas'], ['clients', 'users', 'Clientes'], ['internal', 'lock', 'Internas']] as [string, UiIconName, string][]).map(([key, icon, label]) => (
              <button type="button" key={key} className={`crm-conv-rail-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key as typeof tab)} title={label} aria-label={label}><Ui name={icon} size={20} /></button>
            ))}
          </div>
          <div className="crm-conv-rail-sep" />
          <div className="crm-conv-rail-list">
            {filteredConversations.map((c) => (
              <button
                type="button"
                key={c.id}
                className={`crm-conv-rail-avatar ${selected?.id === c.id ? 'active' : ''}`}
                onClick={() => openConversation(c.id)}
                title={`${contactLabel(c.contact)}${c.contact.phone ? ` · ${formatPhone(c.contact.phone)}` : ''}`}
                aria-label={contactLabel(c.contact)}
              >
                <Avatar contact={c.contact} />
                <i className="crm-conv-rail-dot" style={{ background: stageDotColor(c) }} />
                {(c.unreadCount || 0) > 0 && <span className="crm-rail-unread">{(c.unreadCount || 0) > 9 ? '9+' : c.unreadCount}</span>}
              </button>
            ))}
            {!loadingList && filteredConversations.length === 0 && <span className="crm-conv-rail-empty">Sin chats</span>}
          </div>
        </aside>
      )}

      {/* =========================================================
          COLUMN 2: ACTIVE CHAT WINDOW
          ========================================================= */}
      <div className="crm-chat-column">
        <div className="mobile-chat-navigation">
          <button type="button" onClick={() => { setSelectedId(null); setMobileInfo(false); setLeftCollapsed(false); navigate('/inbox', { replace: true }); }}><Ui name="chevron-left" size={20} /> Chats</button>
          <span>Conversación</span>
          <button type="button" onClick={() => { setMobileInfo(true); setRightCollapsed(false); }}>Contacto <Ui name="user" size={18} /></button>
        </div>
        {selected ? (
          <ActiveChatWindow
            key={selected.id}
            draft={drafts.current.get(selected.id)}
            onDraftChange={(draft) => { drafts.current.set(selected.id, draft); }}
            conversation={selected}
            onConversationChange={upsertConversation}
            onOpenTransfer={() => setShowTransferModal(true)}
            onOpenOrder={() => setShowOrderModal(true)}
            onOpenImage={(url, fileName) => setLightboxImage({ url, fileName })}
            leftCollapsed={leftCollapsed}
            onToggleLeft={() => setLeftCollapsed((v) => !v)}
            rightCollapsed={rightCollapsed}
            onToggleRight={() => { if (window.matchMedia('(max-width: 860px)').matches) { setMobileInfo(true); setRightCollapsed(false); } else setRightCollapsed((v) => !v); }}
            starredIds={starredIds}
            onToggleStar={toggleStarMessage}
            onOpenForward={(m) => setForwardMessage(m)}
            showToast={showToast}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
            Selecciona una conversación para interactuar
          </div>
        )}
      </div>

      {/* =========================================================
          COLUMN 3: CONTACT INFO & QUICK ACTIONS
          ========================================================= */}
      {selected && (
        rightCollapsed ? (
          <ContactInfoRail conversation={selected} onExpand={() => setRightCollapsed(false)} />
        ) : (
          <ContactInfoPanel
            conversation={selected}
            onConversationChange={upsertConversation}
            onOpenTransfer={() => setShowTransferModal(true)}
            onOpenOrder={() => setShowOrderModal(true)}
            onEditContact={() => setEditingContact(selected.contact)}
            onClose={() => { setRightCollapsed(true); setMobileInfo(false); }}
          />
        )
      )}

      {mobileInfo && <button type="button" className="mobile-info-backdrop" aria-label="Cerrar información del contacto" onClick={() => setMobileInfo(false)} />}
      {/* Incoming transfer banner */}
      {incomingTransfer && (
        <div className="crm-transfer-banner">
          <div>
            <strong><Ui name="transfer" size={16} /> Nueva conversación transferida</strong>
            <span>
              {incomingTransfer.fromAgent} te transfirió a {contactLabel(incomingTransfer.conversation.contact)}
              {incomingTransfer.note ? ` — "${incomingTransfer.note}"` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn small" disabled={respondingTransfer} onClick={() => respondToTransfer('accept')}>
              Aceptar
            </button>
            <button type="button" className="btn secondary small" disabled={respondingTransfer} onClick={() => respondToTransfer('reject')}>
              Rechazar
            </button>
          </div>
        </div>
      )}

      {/* Modals */}
      {lightboxImage && (
        <LightboxModal
          url={lightboxImage.url}
          fileName={lightboxImage.fileName}
          onClose={() => setLightboxImage(null)}
        />
      )}

      {showNew && (
        <NewConversationModal
          onClose={() => setShowNew(false)}
          onCreated={(conversation) => {
            upsertConversation(conversation);
            setSelectedId(conversation.id);
            setShowNew(false);
          }}
        />
      )}

      {showTransferModal && selected && (
        <TransferConversationModal
          conversation={selected}
          onClose={() => setShowTransferModal(false)}
          onTransferred={(updated) => {
            upsertConversation(updated);
            setShowTransferModal(false);
          }}
        />
      )}

      {showOrderModal && selected && (
        <CreateOrderModal
          conversation={selected}
          onClose={() => setShowOrderModal(false)}
          onCreated={() => {
            setShowOrderModal(false);
            showToast('¡Pedido registrado con éxito en el CRM!');
          }}
        />
      )}

      {/* Forward Message Modal */}
      {forwardMessage && (
        <ForwardMessageModal
          message={forwardMessage}
          conversations={conversations}
          onClose={() => setForwardMessage(null)}
          onForwarded={(targetId) => {
            setForwardMessage(null);
            setSelectedId(targetId);
            showToast('Mensaje reenviado con éxito');
          }}
        />
      )}

      {/* Edit Contact Modal */}
      {editingContact && (
        <EditContactModal
          contact={editingContact}
          onClose={() => setEditingContact(null)}
          onSaved={(updated) => {
            setEditingContact(null);
            setConversations((prev) =>
              prev.map((c) => (c.contact.id === updated.id ? { ...c, contact: updated } : c))
            );
            showToast('Contacto actualizado correctamente');
          }}
        />
      )}

    </div>
  );
}

/* =========================================================
   LIGHTBOX MODAL FOR IMAGE ZOOM & PREVIEW
   ========================================================= */
function LightboxModal({ url, fileName, onClose }: { url: string; fileName: string; onClose: () => void }) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'absolute',
          top: 20,
          right: 24,
          display: 'flex',
          gap: 12,
          zIndex: 10000
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <a
          href={url}
          download={fileName}
          className="btn small"
          style={{ background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', textDecoration: 'none' }}
        >
          <Ui name="download" size={14} /> Descargar
        </a>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'rgba(255, 255, 255, 0.2)',
            border: 'none',
            color: '#fff',
            fontSize: 18,
            width: 36,
            height: 36,
            borderRadius: '50%',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Ui name="x" size={16} />
        </button>
      </div>

      <div
        style={{
          maxWidth: '92vw',
          maxHeight: '85vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={url}
          alt={fileName}
          style={{
            maxWidth: '100%',
            maxHeight: '85vh',
            objectFit: 'contain',
            borderRadius: 8,
            boxShadow: '0 10px 40px rgba(0,0,0,0.8)'
          }}
        />
      </div>
      <div style={{ color: '#fff', marginTop: 12, fontSize: 13, opacity: 0.85 }}>
        {fileName}
      </div>
    </div>
  );
}

/* =========================================================
   ACTIVE CHAT WINDOW (Column 2) - WHATSAPP WEB STYLE
   ========================================================= */
function ActiveChatWindow({
  draft,
  onDraftChange,
  conversation,
  onConversationChange,
  onOpenTransfer,
  onOpenOrder,
  onOpenImage,
  leftCollapsed,
  onToggleLeft,
  rightCollapsed,
  onToggleRight,
  starredIds,
  onToggleStar,
  onOpenForward,
  showToast
}: {
  draft?: { text: string; mode: 'outbound' | 'note' | 'inbound' };
  onDraftChange: (draft: { text: string; mode: 'outbound' | 'note' | 'inbound' }) => void;
  conversation: Conversation;
  onConversationChange: (c: Conversation) => void;
  onOpenTransfer: () => void;
  onOpenOrder: () => void;
  onOpenImage: (url: string, fileName: string) => void;
  leftCollapsed: boolean;
  onToggleLeft: () => void;
  rightCollapsed: boolean;
  onToggleRight: () => void;
  starredIds: Set<string>;
  onToggleStar: (msgId: string) => void;
  onOpenForward: (message: Message) => void;
  showToast: (msg: string) => void;
}) {
  const { confirm, notify } = useAlerts();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState(draft?.text || '');
  const [mode, setMode] = useState<'outbound' | 'note' | 'inbound'>(draft?.mode || 'outbound');
  useEffect(() => { onDraftChange({ text: content, mode }); }, [content, mode, onDraftChange]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [changingStage, setChangingStage] = useState(false);
  const { patchConversation } = useOutcome();
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [extendedEmojiFor, setExtendedEmojiFor] = useState<Message | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const handledTransferId = useRef(new Set<string>());
  const [autoTranscribe, setAutoTranscribe] = useState(false);
  useEffect(() => {
    apiGet<{ organization: { settings: { autoTranscribeAudio?: boolean } | null } }>('/api/org').then((r) => setAutoTranscribe(Boolean(r.organization.settings?.autoTranscribeAudio))).catch(() => {});
  }, []);

  function insertEmojiInComposer(emoji: string) {
    const input = chatInputRef.current;
    if (!input) { setContent((prev) => prev + emoji); return; }
    const start = input.selectionStart ?? content.length;
    const end = input.selectionEnd ?? content.length;
    setContent(content.slice(0, start) + emoji + content.slice(end));
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + emoji.length, start + emoji.length); });
  }
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showPollModal, setShowPollModal] = useState(false);
  const [showContactShareModal, setShowContactShareModal] = useState(false);
  const [showCameraModal, setShowCameraModal] = useState(false);
  const [recording, setRecording] = useState(false);
  const { user: me } = useAuth();
  const quick = useQuickReplies();
  const [caret, setCaret] = useState(0);
  const [qrIndex, setQrIndex] = useState(0);
  const [qrForced, setQrForced] = useState(false);
  const [qrDismissed, setQrDismissed] = useState<string | null>(null);
  const [qrManager, setQrManager] = useState<{ startNew: boolean; shortcut?: string } | null>(null);
  const quickContext = { name: conversation.contact.name, phone: conversation.contact.phone, email: conversation.contact.email, agent: me?.name, company: me?.organization?.name };
  const slash = detectSlash(content, caret);
  const slashKey = slash ? `${slash.start}:${slash.query}` : null;
  const qrOpen = !recording && !qrManager && (qrForced || (slash !== null && slashKey !== qrDismissed));
  const closeQuick = () => { setQrForced(false); setQrDismissed(slashKey); };
  const qrItems = rankReplies(quick.items, qrForced && !slash ? '' : slash?.query || '').slice(0, 40);
  const canManageQuick = can(me, 'quickReplies');

  useEffect(() => { setQrIndex(0); }, [slashKey, qrForced, quick.items.length]);

  // La barra de escribir crece con el texto (hasta 140 px), como en WhatsApp Web.
  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [content]);

  function pickQuickReply(reply: QuickReply) {
    const text = fillTemplate(reply.content, quickContext);
    const el = chatInputRef.current;
    const pos = el?.selectionStart ?? caret;
    const token = detectSlash(content, pos);
    const before = token ? content.slice(0, token.start) : content.slice(0, pos);
    const after = content.slice(pos);
    const next = before + text + after;
    setContent(next);
    setQrForced(false);
    setQrDismissed(null);
    apiPost(`/api/org/quick-replies/${reply.id}/use`).catch(() => {});
    const newCaret = (before + text).length;
    setCaret(newCaret);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(newCaret, newCaret); });
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (qrOpen && qrItems.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setQrIndex((i) => (i + 1) % qrItems.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setQrIndex((i) => (i - 1 + qrItems.length) % qrItems.length); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickQuickReply(qrItems[qrIndex]); return; }
    }
    if (qrOpen && event.key === 'Escape') { event.preventDefault(); closeQuick(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) { event.preventDefault(); handleSendMessage(); }
  }
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [respondingTransfer, setRespondingTransfer] = useState(false);
  const [directCall, setDirectCall] = useState<DirectCall | null>(null);
  const audioRef = useRef<CallAudio | null>(null);
  const callIdRef = useRef<string | null>(null);
  const [callMuted, setCallMuted] = useState(false);
  const [directCallBusy, setDirectCallBusy] = useState(false);
  const [directCallError, setDirectCallError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const currentStage = deriveStage(conversation);

  useEffect(() => {
    if (!recording) {
      setRecordingSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    setDirectCall(null);
    setDirectCallError(null);
    setDirectCallBusy(false);
    setCallMuted(false);
    return () => {
      audioRef.current?.stop(); audioRef.current = null;
      const id = callIdRef.current; callIdRef.current = null;
      if (id) void apiPost(`/api/org/wa-calls/direct/${id}/hangup`, {}).catch(() => {});
    };
  }, [conversation.id]);

  useEffect(() => {
    if (!directCall || !DIRECT_CALL_ACTIVE_STATUSES.has(directCall.status)) return;
    let cancelled = false;
    const poll = window.setInterval(async () => {
      try {
        const result = await apiGet<{ call: DirectCall }>(`/api/org/wa-calls/direct/${directCall.id}`);
        if (!cancelled) {
          setDirectCall(result.call);
          if (!DIRECT_CALL_ACTIVE_STATUSES.has(result.call.status)) {
            audioRef.current?.stop(); audioRef.current = null; callIdRef.current = null;
          }
        }
      } catch {
        // The server keeps direct calls in memory for a short period; a transient
        // polling error should not interrupt the call already in progress.
      }
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [directCall?.id, directCall?.status]);

  async function handleDirectCall() {
    if (!cleanPhone || directCallBusy) return;
    const name = contactLabel(conversation.contact);
    const accepted = await confirm({ title: 'Iniciar llamada de WhatsApp', message: `¿Querés llamar a ${name}?`, confirmLabel: 'Iniciar llamada', tone: 'warning' });
    if (!accepted) return;
    setDirectCallBusy(true);
    setDirectCallError(null);
    const audio = new CallAudio(message => {
      setDirectCallError(message);
      audioRef.current?.stop();
      if (callIdRef.current) void apiPost(`/api/org/wa-calls/direct/${callIdRef.current}/hangup`, {}).catch(() => {});
    });
    audioRef.current = audio;
    try {
      await audio.prepare();
      if (audioRef.current !== audio) return;
      const result = await apiPost<{ call: DirectCall }>('/api/org/wa-calls/direct', { conversationId: conversation.id });
      if (audioRef.current !== audio) {
        await apiPost(`/api/org/wa-calls/direct/${result.call.id}/hangup`, {});
        return;
      }
      callIdRef.current = result.call.id;
      setDirectCall(result.call);
      if (!result.call.audioToken) throw new Error('El servidor no habilitó el audio de la llamada');
      await audio.attach(result.call.id, result.call.audioToken);
      showToast(`${directCallStatusLabel(result.call.status)} a ${name}`);
    } catch (err) {
      audio.stop();
      if (callIdRef.current) void apiPost(`/api/org/wa-calls/direct/${callIdRef.current}/hangup`, {}).catch(() => {});
      const message = err instanceof Error ? err.message : 'No se pudo iniciar la llamada';
      setDirectCallError(message);
      showToast(`${message}`);
    } finally {
      setDirectCallBusy(false);
    }
  }

  async function handleDirectCallHangup() {
    if (!directCall || directCallBusy) return;
    setDirectCallBusy(true);
    try {
      const result = await apiPost<{ call: DirectCall }>(`/api/org/wa-calls/direct/${directCall.id}/hangup`, {});
      setDirectCall(result.call);
      audioRef.current?.stop(); audioRef.current = null; callIdRef.current = null;
      showToast('Llamada finalizada');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'No se pudo finalizar la llamada';
      setDirectCallError(message);
    } finally {
      setDirectCallBusy(false);
    }
  }

  // Close menus on outside click
  useEffect(() => {
    function handleClickOutside() {
      setMenuOpenFor(null);
    }
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  async function handleStageChange(e: ChangeEvent<HTMLSelectElement>) {
    const stage = e.target.value as CrmStage;
    if (stage === currentStage) return;
    setChangingStage(true);
    const nextTags = tagsForStage(conversation.tags, stage);
    const nextStatus = statusForStage(stage);
    try {
      // Pasar a "Cerradas" cierra la conversación: pide cómo terminó (venta, perdida, cotización…).
      const res = await patchConversation(conversation, { tags: nextTags, ...(nextStatus ? { status: nextStatus } : {}) });
      if (res) onConversationChange(res.conversation);
    } catch (err) {
      console.error(err);
    } finally {
      setChangingStage(false);
    }
  }

  useEffect(() => {
    // Drop the previous chat's messages right away and ignore late responses: otherwise their
    // attachments are rendered under the new conversation and every media request 404s.
    let cancelled = false;
    setMessages([]);
    setLoading(true);
    apiGet<{ messages: Message[] }>(`/api/org/conversations/${conversation.id}`)
      .then((data) => { if (!cancelled) setMessages(data.messages); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conversation.id]);

  useEffect(() => {
    const socket = getSocket();
    const onMessage = ({ conversationId, message }: { conversationId: string; message: Message }) => {
      if (conversationId !== conversation.id) return;
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    };
    const onMessageUpdated = ({ conversationId, message }: { conversationId: string; message: Message }) => {
      if (conversationId !== conversation.id) return;
      setMessages((prev) => prev.map((m) => (m.id === message.id ? message : m)));
      if (message.direction === 'OUTBOUND' && message.deliveryStatus === 'failed') {
        notify('No se pudo enviar el audio. Verificá la conexión de WhatsApp y que FFmpeg esté instalado.', { tone: 'error', title: 'Audio no enviado' });
      }
    };
    const onMessageDeleted = ({ conversationId, messageId }: { conversationId: string; messageId: string }) => {
      if (conversationId !== conversation.id) return;
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    };
    socket.on('message:new', onMessage);
    socket.on('message:updated', onMessageUpdated);
    socket.on('message:deleted', onMessageDeleted);
    return () => {
      socket.off('message:new', onMessage);
      socket.off('message:updated', onMessageUpdated);
      socket.off('message:deleted', onMessageDeleted);
    };
  }, [conversation.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function handleSendMessage(textToSend?: string) {
    const messageContent = (textToSend || content).trim();
    if (!messageContent || sending) return;
    if (!navigator.onLine) { notify('Sin conexión. Tu borrador sigue aquí; volvé a enviarlo cuando tengas Internet.', { tone: 'error' }); return; }
    setSending(true);
    try {
      const res = await apiPost<{ message: Message }>(`/api/org/conversations/${conversation.id}/messages`, {
        content: messageContent,
        type: mode,
        quotedMessageId: replyTo?.id
      });
      if (res?.message) {
        setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      }
      if (!textToSend) setContent('');
      setReplyTo(null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'No se pudo enviar. Tu borrador sigue aquí para reintentar.', { tone: 'error' });
    } finally {
      setSending(false);
    }
  }

  async function handleReact(message: Message, emoji: string | null) {
    setExtendedEmojiFor(null);
    setMenuOpenFor(null);
    try {
      const res = await apiPost<{ message: Message }>(`/api/org/conversations/${conversation.id}/messages/${message.id}/react`, { emoji });
      setMessages((prev) => prev.map((m) => (m.id === message.id ? res.message : m)));
      if (emoji) showToast(`Reaccionaste con ${emoji}`);
    } catch (err) {
      console.error(err);
    }
  }

  function myReaction(message: Message): string | null {
    return message.reactions.find((r) => r.from === 'agent')?.emoji || null;
  }

  async function handleDeleteMessage(message: Message) {
    setMenuOpenFor(null);
    const accepted = await confirm({ title: 'Eliminar mensaje', message: 'Si el chat es de WhatsApp, también se borrará para el cliente.', confirmLabel: 'Eliminar mensaje', tone: 'danger' });
    if (!accepted) return;
    try {
      await apiDelete(`/api/org/conversations/${conversation.id}/messages/${message.id}`);
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
      showToast('Mensaje eliminado');
    } catch (err) {
      console.error(err);
    }
  }

  async function uploadFile(file: File | Blob, fileName: string, ptt?: boolean) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file, fileName);
      formData.append('type', mode);
      if (ptt) formData.append('ptt', 'true');
      const result = await apiUpload<{ message: Message }>(`/api/org/conversations/${conversation.id}/attachments`, formData);
      if (result?.message) setMessages((prev) => (prev.some((m) => m.id === result.message.id) ? prev : [...prev, result.message]));
      if (ptt) notify('Nota de voz grabada. Enviando a WhatsApp…', { tone: 'success' });
    } catch (err) {
      console.error(err);
      notify(err instanceof ApiError ? err.message : 'No se pudo subir el audio', { tone: 'error', title: 'Audio no enviado' });
    } finally {
      setUploading(false);
    }
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await uploadFile(file, file.name);
  }

  async function handleToggleRecording() {
    if (mode === 'note') {
      notify('Cambiá a conversación para enviar una nota de voz al contacto.', { tone: 'info', title: 'Nota interna activa' });
      return;
    }
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    let activeStream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Este navegador no admite grabación de audio');
      }
      const stream = activeStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const supportedTypes = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      const preferredType = typeof MediaRecorder.isTypeSupported === 'function'
        ? supportedTypes.find((type) => MediaRecorder.isTypeSupported(type))
        : undefined;
      const recorder = preferredType ? new MediaRecorder(stream, { mimeType: preferredType }) : new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const mimeType = recorder.mimeType || preferredType || 'audio/webm';
        const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        if (blob.size === 0) {
          notify('La grabación quedó vacía. Probá nuevamente.', { tone: 'error', title: 'Nota de voz vacía' });
          return;
        }
        uploadFile(blob, `nota-de-voz-${Date.now()}.${extension}`, true);
        mediaRecorderRef.current = null;
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        mediaRecorderRef.current = null;
        notify('La grabación se interrumpió. Revisá el micrófono e intentá de nuevo.', { tone: 'error', title: 'Error de grabación' });
      };
      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
    } catch (err) {
      activeStream?.getTracks().forEach((track) => track.stop());
      console.error(err);
      notify(err instanceof Error && err.message.includes('no admite') ? err.message : 'No se pudo acceder al micrófono. Revisá los permisos del navegador.', { tone: 'error', title: 'Micrófono no disponible' });
    }
  }

  async function handleTransferResponse(action: 'accept' | 'reject') {
    setRespondingTransfer(true);
    try {
      const res = await apiPost<{ conversation: Conversation; accepted: boolean }>(
        `/api/org/conversations/${conversation.id}/transfer-response`,
        { action }
      );
      if (lastTransferNote) handledTransferId.current.add(lastTransferNote.id); // se oculta al instante, sin esperar al servidor
      onConversationChange(res.conversation);
    } catch (e) {
      console.error(e);
    } finally {
      setRespondingTransfer(false);
    }
  }

  const cleanPhone = isUsablePhone(conversation.contact.phone) ? phoneDigits(conversation.contact.phone) : null;

  // El aviso Aceptar/Rechazar existe solo mientras la transferencia está pendiente: desaparece apenas
  // alguien la acepta o la rechaza (queda como nota en el historial) y solo lo ve a quien se le transfirió.
  const lastTransferIndex = messages.reduce((found, m, i) => (m.direction === 'NOTE' && m.content.includes('[TRANSFERENCIA]') ? i : found), -1);
  const transferResolved = lastTransferIndex >= 0 && messages.slice(lastTransferIndex + 1).some((m) => m.direction === 'NOTE' && (m.content.includes('aceptó la transferencia') || m.content.includes('rechazó la transferencia')));
  const lastTransferNote = lastTransferIndex >= 0 && !transferResolved && !handledTransferId.current.has(messages[lastTransferIndex].id) && conversation.assignedTo?.id === me?.id ? messages[lastTransferIndex] : undefined;

  return (
    <>
      {/* Header with Contact Status, Collapse Toggles, and Action buttons */}
      <div className="crm-chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {leftCollapsed && (
            <button
              type="button"
              className="composer-action-btn"
              onClick={onToggleLeft}
              title="Mostrar lista de conversaciones"
              style={{ fontSize: 13 }}
            >
              <Ui name="chevron-right" size={16} />
            </button>
          )}

          <div className="crm-chat-user-header">
            <div className="crm-conv-avatar-box">
              <Avatar contact={conversation.contact} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-main)' }}>
                  {contactLabel(conversation.contact)}
                </span>
                {conversation.contact.phone && (
                  <span style={{ fontSize: 12, color: 'var(--primary-glow)', fontWeight: 600 }}>
                    <Ui name="phone" size={12} /> {formatPhone(conversation.contact.phone)}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, marginTop: 1 }}>
                <span style={{ color: 'var(--text-dim)', fontWeight: 600, textTransform: 'capitalize' }}>{conversation.channel}</span>
                {cleanPhone && (
                  <a
                    href={`https://wa.me/${cleanPhone}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: '#25d366', textDecoration: 'none', fontWeight: 700 }}
                  >
                    WhatsApp <Ui name="external" size={12} />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="crm-chat-header-actions">
          <select
            className="crm-stage-select"
            value={currentStage}
            onChange={handleStageChange}
            disabled={changingStage}
            title="Enviar esta conversación al tablero CRM"
          >
            {CRM_STAGES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="composer-action-btn"
            title={conversation.channel !== 'whatsapp' ? 'Disponible solo para chats de WhatsApp' : directCall && DIRECT_CALL_ACTIVE_STATUSES.has(directCall.status) ? 'Finalizar llamada' : 'Llamar a este contacto'}
            aria-label={directCall && DIRECT_CALL_ACTIVE_STATUSES.has(directCall.status) ? 'Finalizar llamada' : 'Llamar a este contacto'}
            onClick={directCall && DIRECT_CALL_ACTIVE_STATUSES.has(directCall.status) ? handleDirectCallHangup : handleDirectCall}
            disabled={conversation.channel !== 'whatsapp' || !cleanPhone || directCallBusy}
            style={directCall && DIRECT_CALL_ACTIVE_STATUSES.has(directCall.status) ? { background: 'rgba(239, 68, 68, 0.12)', color: '#dc2626' } : undefined}
          >
            <Ui name={directCallBusy ? 'clock' : directCall && DIRECT_CALL_ACTIVE_STATUSES.has(directCall.status) ? 'phone-off' : 'phone'} />
          </button>
          {directCall && DIRECT_CALL_ACTIVE_STATUSES.has(directCall.status) && (
            <button type="button" className="composer-action-btn" aria-label={callMuted ? 'Activar micrófono' : 'Silenciar micrófono'} aria-pressed={callMuted}
              onClick={() => { audioRef.current?.mute(!callMuted); setCallMuted(!callMuted); }}>
              <Ui name={callMuted ? 'mic-off' : 'mic'} />
            </button>
          )}
          <button
            type="button"
            className="composer-action-btn"
            title="Transferir chat a otro agente"
            onClick={onOpenTransfer}
          >
            <Ui name="transfer" />
          </button>
          <button
            type="button"
            className="composer-action-btn"
            title="Crear pedido"
            onClick={onOpenOrder}
          >
            <Ui name="cart" />
          </button>
          <button
            type="button"
            className="composer-action-btn"
            title={rightCollapsed ? 'Mostrar información del contacto' : 'Ocultar panel lateral'}
            onClick={onToggleRight}
            style={!rightCollapsed ? { background: 'var(--primary-soft)', color: 'var(--primary-glow)' } : undefined}
          >
            <Ui name="info" />
          </button>
        </div>
      </div>

      {(directCall || directCallError) && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '7px 16px',
            background: directCallError ? 'rgba(239, 68, 68, 0.08)' : 'rgba(37, 211, 102, 0.09)',
            borderBottom: '1px solid var(--border-color)',
            color: directCallError ? '#b91c1c' : 'var(--text-main)',
            fontSize: 12
          }}
        >
          <span>{directCallError || (directCall ? directCallStatusLabel(directCall.status, directCall.endedReason) : '')}</span>
          {directCallError && <button type="button" className="composer-action-btn" onClick={() => setDirectCallError(null)} aria-label="Cerrar error">×</button>}
        </div>
      )}

      {/* Transfer Notification Banner (Accept / Reject) */}
      {lastTransferNote && (
        <div
          style={{
            background: 'linear-gradient(90deg, rgba(2, 132, 199, 0.16) 0%, rgba(37, 99, 235, 0.16) 100%)',
            borderBottom: '1px solid var(--border-color)',
            padding: '10px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12
          }}
        >
          <div style={{ fontSize: 12.5, color: 'var(--text-main)' }}>
            <strong style={{ color: 'var(--primary-glow)' }}><Ui name="transfer" size={14} /> Transferencia: </strong>
            <span>{lastTransferNote.content.replace('🔄 [TRANSFERENCIA]: ', '')}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              className="btn small"
              disabled={respondingTransfer}
              onClick={() => handleTransferResponse('accept')}
              style={{ background: '#10b981', color: '#fff', fontSize: 11.5, padding: '4px 10px' }}
            >
              <Ui name="check" size={16} /> Aceptar
            </button>
            <button
              type="button"
              className="btn secondary small"
              disabled={respondingTransfer}
              onClick={() => handleTransferResponse('reject')}
              style={{ color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.4)', fontSize: 11.5, padding: '4px 10px' }}
            >
              <Ui name="x" size={16} /> Rechazar
            </button>
          </div>
        </div>
      )}

      {/* Messages Feed */}
      <div className="crm-chat-messages-body" ref={scrollRef}>
        {loading && <p style={{ color: 'var(--text-dim)', textAlign: 'center' }}>Cargando conversación...</p>}
        {!loading && messages.length === 0 && (
          <p style={{ color: 'var(--text-dim)', textAlign: 'center' }}>Todavía no hay mensajes en esta conversación.</p>
        )}

        {messages.map((m) => {
          const mine = myReaction(m);
          const otherReactions = m.reactions.filter((r) => r.from !== 'agent');
          const isStarred = starredIds.has(m.id);
          const isMenuOpen = menuOpenFor === m.id;

          return (
            <div key={m.id} className={`chat-bubble-container ${m.direction.toLowerCase()}${mine || otherReactions.length > 0 ? ' has-reactions' : ''}`}>
              {/* WhatsApp Web Hover Action Bar */}
              <div className="crm-msg-actions">
                {/* Quick WhatsApp Reaction Bar */}
                <div className="crm-wa-reaction-bar" onClick={(e) => e.stopPropagation()}>
                  {QUICK_REACTIONS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className="crm-wa-reaction-btn"
                      title={`Reaccionar con ${e}`}
                      onClick={() => handleReact(m, mine === e ? null : e)}
                      style={mine === e ? { background: 'var(--primary-soft)', transform: 'scale(1.18)' } : undefined}
                    >
                      {e}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="crm-wa-reaction-btn more-btn"
                    title="Más emojis..."
                    onClick={() => setExtendedEmojiFor(m)}
                  >
                    <Ui name="plus" size={16} />
                  </button>
                </div>

                {/* WhatsApp Web Dropdown Chevron Button */}
                <div style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className="crm-wa-more-actions-btn"
                    title="Opciones del mensaje"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpenFor((prev) => (prev === m.id ? null : m.id));
                    }}
                  >
                    ⌄
                  </button>

                  {/* Contextual WhatsApp Web Dropdown Menu */}
                  {isMenuOpen && (
                    <div className="crm-wa-context-menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="crm-wa-menu-item"
                        onClick={() => {
                          setReplyTo(m);
                          setMenuOpenFor(null);
                        }}
                      >
                        <Ui name="reply" size={16} /> Responder
                      </button>
                      <button
                        type="button"
                        className="crm-wa-menu-item"
                        onClick={() => {
                          setExtendedEmojiFor(m);
                          setMenuOpenFor(null);
                        }}
                      >
                        <Ui name="smile" size={16} /> Reaccionar
                      </button>
                      <button
                        type="button"
                        className="crm-wa-menu-item"
                        onClick={() => {
                          onOpenForward(m);
                          setMenuOpenFor(null);
                        }}
                      >
                        <Ui name="forward" size={16} /> Reenviar
                      </button>
                      {m.content && (
                        <button
                          type="button"
                          className="crm-wa-menu-item"
                          onClick={() => {
                            navigator.clipboard.writeText(m.content);
                            showToast('Texto copiado al portapapeles');
                            setMenuOpenFor(null);
                          }}
                        >
                          <Ui name="copy" size={16} /> Copiar texto
                        </button>
                      )}
                      <button
                        type="button"
                        className="crm-wa-menu-item"
                        onClick={() => {
                          onToggleStar(m.id);
                          setMenuOpenFor(null);
                        }}
                      >
                        <Ui name="star" size={16} /> {isStarred ? 'Quitar de destacados' : 'Destacar mensaje'}
                      </button>
                      <div className="crm-wa-menu-divider" />
                      {m.direction !== 'INBOUND' && (
                        <button
                          type="button"
                          className="crm-wa-menu-item"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => handleDeleteMessage(m)}
                        >
                          <Ui name="trash" size={16} /> Eliminar mensaje
                        </button>
                      )}
                      <button
                        type="button"
                        className="crm-wa-menu-item"
                        onClick={() => {
                          onOpenTransfer();
                          setMenuOpenFor(null);
                        }}
                      >
                        <Ui name="transfer" size={16} /> Transferir chat
                      </button>
                      <button
                        type="button"
                        className="crm-wa-menu-item"
                        onClick={() => {
                          onOpenOrder();
                          setMenuOpenFor(null);
                        }}
                      >
                        <Ui name="cart" size={16} /> Crear pedido
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Bubble Content */}
              <div className={`chat-bubble ${m.direction.toLowerCase()}`}>
                {(m.quotedPreview || m.quotedMessageId) && (
                  <div className="crm-quoted-block">
                    <strong>{m.quotedSender || 'Mensaje'}</strong>
                    <span>{m.quotedPreview || messages.find((x) => x.id === m.quotedMessageId)?.content}</span>
                  </div>
                )}
                <AttachmentContent message={m} conversationId={conversation.id} onOpenImage={onOpenImage} />
                {m.attachment?.mimeType.startsWith('audio/') && <AudioTranscript message={m} autoEnabled={autoTranscribe} conversationId={conversation.id} />}
                <MessageBody message={m} />
              </div>

              {/* Reacciones: chips sobre el borde inferior de la burbuja; el mismo emoji de varias personas se agrupa con contador */}
              {(mine || otherReactions.length > 0) && (
                <div className="crm-reaction-row" role="group" aria-label="Reacciones">
                  {groupReactions(mine, otherReactions).map((g) => (
                    <button
                      key={g.emoji}
                      type="button"
                      className={`crm-reaction-chip${g.mine ? ' mine' : ''}`}
                      title={g.mine ? 'Tu reacción (clic para quitar)' : g.title}
                      aria-label={`${g.emoji} ${g.title}`}
                      disabled={!g.mine}
                      onClick={() => g.mine && handleReact(m, null)}
                    >
                      <span className="crm-reaction-emoji">{g.emoji}</span>
                      {g.count > 1 && <span className="crm-reaction-count">{g.count}</span>}
                    </button>
                  ))}
                </div>
              )}

              {/* Bubble Meta (Time, Starred icon, Delivery status) */}
              <div className="chat-bubble-meta" style={m.direction === 'OUTBOUND' ? { alignSelf: 'flex-end' } : {}}>
                {isStarred && <Ui name="star" size={12} style={{ color: '#f59e0b' }} title="Mensaje destacado" />}
                <MessageAuthor message={m} /> · {formatTime(m.createdAt)}
                {m.direction === 'OUTBOUND' && <MessageTicks status={m.deliveryStatus} />}
              </div>
            </div>
          );
        })}
      </div>

      {/* Extended Emoji Picker Modal */}
      {extendedEmojiFor && (
        <Modal title="Seleccionar reacción" onClose={() => setExtendedEmojiFor(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Elige un emoji para reaccionar al mensaje:</div>
            <EmojiPicker inline onClose={() => setExtendedEmojiFor(null)} onPick={(emoji) => handleReact(extendedEmojiFor, emoji)} />
          </div>
        </Modal>
      )}

      {/* Reply preview bar */}
      {replyTo && (
        <div className="crm-reply-bar">
          <div>
            <strong>Respondiendo a {replyTo.direction === 'INBOUND' ? 'Cliente' : replyTo.sender?.name || 'Agente'}</strong>
            <span>{replyTo.content || '[adjunto]'}</span>
          </div>
          <button type="button" onClick={() => setReplyTo(null)}><Ui name="x" size={16} /></button>
        </div>
      )}

      {/* Composer Bar */}
      <form
        className="crm-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          handleSendMessage();
        }}
      >
        <button
          type="button"
          className="composer-action-btn"
          onClick={() => setMode((m) => (m === 'note' ? 'outbound' : 'note'))}
          title="Nota interna (no se envía al contacto)"
          style={mode === 'note' ? { background: '#fef08a', color: '#854d0e', borderColor: '#facc15' } : undefined}
        >
          <Ui name="note" />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
          style={{ display: 'none' }}
          onChange={handleFileSelected}
        />
        <button
          type="button"
          className="composer-action-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="Adjuntar archivo, imagen, video o documento"
        >
          <Ui name="paperclip" />
        </button>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="composer-action-btn"
            onClick={() => setShowMoreMenu((v) => !v)}
            title="Más opciones"
          >
            <Ui name="plus" />
          </button>
          {showMoreMenu && (
            <div className="crm-emoji-picker composer" style={{ flexDirection: 'column', minWidth: 170, alignItems: 'stretch', padding: 6 }}>
              <button
                type="button"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 13, padding: '7px 8px' }}
                onClick={() => { setShowMoreMenu(false); setShowPollModal(true); }}
              >
                <Ui name="chart" size={16} /> Crear encuesta
              </button>
              <button
                type="button"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 13, padding: '7px 8px' }}
                onClick={() => { setShowMoreMenu(false); setShowContactShareModal(true); }}
              >
                <Ui name="contact" size={16} /> Compartir contacto
              </button>
              <button
                type="button"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 13, padding: '7px 8px' }}
                onClick={() => { setShowMoreMenu(false); setShowCameraModal(true); }}
              >
                <Ui name="camera" size={16} /> Tomar foto
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className={`composer-action-btn ${recording ? 'recording' : ''}`}
          onClick={handleToggleRecording}
          disabled={uploading || mode === 'note'}
          title={recording ? `Detener y enviar nota de voz (${recordingSeconds}s)` : 'Grabar nota de voz'}
        >
          <Ui name={recording ? 'stop' : 'mic'} />
        </button>

        <button
          type="button"
          className={`composer-action-btn ${qrOpen ? 'recording' : ''}`}
          style={qrOpen ? { background: 'var(--primary-soft)', color: '#10b981' } : undefined}
          data-qr-keep
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { setQrDismissed(null); setQrForced((v) => !v); chatInputRef.current?.focus(); }}
          title="Respuestas rápidas (o escribí / en el chat)"
          aria-label="Respuestas rápidas"
        >
          <Ui name="zap" />
        </button>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="composer-action-btn"
            onClick={() => setShowEmojiPicker((v) => !v)}
            title="Insertar emoji"
            data-emoji-toggle
          >
            <Ui name="smile" />
          </button>
          {showEmojiPicker && <EmojiPicker keepOpen onPick={insertEmojiInComposer} onClose={() => setShowEmojiPicker(false)} />}
        </div>

        <textarea
          ref={chatInputRef}
          data-qr-keep
          className="crm-chat-textarea"
          rows={1}
          placeholder={
            mode === 'note'
              ? 'Escribir nota interna para el equipo...'
              : recording
                ? `Grabando nota de voz… ${String(Math.floor(recordingSeconds / 60)).padStart(2, '0')}:${String(recordingSeconds % 60).padStart(2, '0')}`
                : 'Escribí un mensaje…'
          }
          value={content}
          onChange={(e) => { setContent(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setQrForced(false); }}
          onKeyDown={handleComposerKeyDown}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          disabled={recording}
        />

        {qrOpen && (
          <QuickReplyPopover items={qrItems} query={qrForced && !slash ? '' : slash?.query || ''} activeIndex={qrIndex} context={quickContext} canManage={canManageQuick} loaded={quick.loaded}
            onPick={pickQuickReply} onHover={setQrIndex} onClose={closeQuick}
            onManage={() => { closeQuick(); setQrManager({ startNew: false }); }}
            onCreate={(shortcut) => { closeQuick(); setQrManager({ startNew: true, shortcut }); }} />
        )}

        <button className="btn-send-message" aria-label="Enviar mensaje" type="submit" disabled={sending || recording || !content.trim()}>
          <Ui name="send" />
        </button>
      </form>

      {qrManager && <QuickReplyManager items={quick.items} context={quickContext} startNew={qrManager.startNew} initialShortcut={qrManager.shortcut} onClose={() => setQrManager(null)} onChanged={quick.reload} />}

      {showPollModal && (
        <CreatePollModal
          conversationId={conversation.id}
          onClose={() => setShowPollModal(false)}
          onCreated={() => setShowPollModal(false)}
        />
      )}

      {showContactShareModal && (
        <ShareContactModal
          conversationId={conversation.id}
          onClose={() => setShowContactShareModal(false)}
          onShared={() => setShowContactShareModal(false)}
        />
      )}

      {showCameraModal && (
        <CameraModal
          onClose={() => setShowCameraModal(false)}
          onCapture={(blob) => {
            setShowCameraModal(false);
            uploadFile(blob, `foto-${Date.now()}.jpg`);
          }}
        />
      )}
    </>
  );
}

/* =========================================================
   CAMERA CAPTURE MODAL
   ========================================================= */
function CameraModal({ onClose, onCapture }: { onClose: () => void; onCapture: (blob: Blob) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => setError('No se pudo acceder a la cámara. Revisá los permisos del navegador.'));

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function handleCapture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setCapturing(true);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        setCapturing(false);
        if (blob) onCapture(blob);
      },
      'image/jpeg',
      0.9
    );
  }

  return (
    <Modal title="Tomar foto" onClose={onClose}>
      {error ? (
        <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>
      ) : (
        <>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{ width: '100%', borderRadius: 10, background: '#000', maxHeight: 340, objectFit: 'cover' }}
          />
          <button
            type="button"
            className="btn"
            onClick={handleCapture}
            disabled={capturing}
            style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
          >
            {capturing ? 'Capturando...' : <><Ui name="camera" size={16} /> Capturar y enviar</>}
          </button>
        </>
      )}
    </Modal>
  );
}

/* =========================================================
   CREATE POLL MODAL
   ========================================================= */
function CreatePollModal({
  conversationId,
  onClose,
  onCreated
}: {
  conversationId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateOption(idx: number, value: string) {
    setOptions((prev) => prev.map((o, i) => (i === idx ? value : o)));
  }

  function addOption() {
    if (options.length >= 12) return;
    setOptions((prev) => [...prev, '']);
  }

  function removeOption(idx: number) {
    if (options.length <= 2) return;
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || cleanOptions.length < 2) {
      setError('Escribí una pregunta y al menos 2 opciones.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`/api/org/conversations/${conversationId}/messages/poll`, {
        question: question.trim(),
        options: cleanOptions
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear la encuesta');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Crear encuesta" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label>Pregunta</label>
          <input className="input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="¿Qué opción preferís?" />
        </div>

        <div className="field">
          <label>Opciones</label>
          {options.map((opt, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input
                className="input"
                value={opt}
                onChange={(e) => updateOption(idx, e.target.value)}
                placeholder={`Opción ${idx + 1}`}
              />
              {options.length > 2 && (
                <button type="button" className="btn secondary small" onClick={() => removeOption(idx)}><Ui name="x" size={14} /></button>
              )}
            </div>
          ))}
          {options.length < 12 && (
            <button type="button" className="btn secondary small" onClick={addOption}>+ Agregar opción</button>
          )}
        </div>

        {error && <p style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</p>}

        <button type="submit" className="btn" disabled={submitting} style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>
          {submitting ? 'Enviando...' : <>Enviar encuesta <Ui name="arrow-right" size={14} /></>}
        </button>
      </form>
    </Modal>
  );
}

/* =========================================================
   SHARE CONTACT MODAL
   ========================================================= */
function ShareContactModal({
  conversationId,
  onClose,
  onShared
}: {
  conversationId: string;
  onClose: () => void;
  onShared: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [sharing, setSharing] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const id = setTimeout(() => {
      apiGet<{ contacts: Contact[] }>(`/api/org/contacts?q=${encodeURIComponent(query.trim())}`)
        .then((data) => setResults(data.contacts))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  async function handleShare(contact: Contact) {
    setSharing(contact.id);
    try {
      await apiPost(`/api/org/conversations/${conversationId}/messages/contact`, { contactId: contact.id });
      onShared();
    } catch (err) {
      console.error(err);
    } finally {
      setSharing(null);
    }
  }

  return (
    <Modal title="Compartir contacto" onClose={onClose}>
      <div className="field">
        <label>Buscar contacto</label>
        <input
          className="input"
          placeholder="Nombre, teléfono o email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
        {results.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => handleShare(c)}
            disabled={sharing === c.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10,
              border: '1px solid var(--border-color)', background: 'var(--bg-surface-2)', color: 'var(--text-main)',
              cursor: 'pointer', textAlign: 'left'
            }}
          >
            <Avatar contact={c} size={30} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{contactLabel(c)}</div>
              {c.phone && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{c.phone}</div>}
            </div>
            {sharing === c.id && <span style={{ fontSize: 11 }}>Enviando...</span>}
          </button>
        ))}
        {query.trim() && results.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>Sin resultados.</p>
        )}
      </div>
    </Modal>
  );
}

const MEDIA_PLACEHOLDERS = new Set(['🎤 Audio', '🖼️ Imagen', '🎬 Video', '📄 Documento', '🩿 Sticker', '🎭 Sticker', 'Audio', 'Imagen', 'Video', 'Sticker', 'Documento']);

const AUTHOR_LABELS: Record<string, { icon: UiIconName; label: string }> = {
  bot: { icon: 'bot' as UiIconName, label: 'Bot' },
  ai: { icon: 'sparkles' as UiIconName, label: 'Asistente IA' },
  phone: { icon: 'smartphone' as UiIconName, label: 'Desde el teléfono' }
};

function MessageAuthor({ message }: { message: Message }) {
  if (message.direction === 'NOTE') return <span className="chat-author"><Ui name="note" size={12} /> Nota interna{message.sender ? ` · ${message.sender.name}` : ''}</span>;
  if (message.direction === 'INBOUND') return <span className="chat-author">Cliente</span>;
  if (message.sender) return <span className="chat-author agent" title="Agente que respondió"><Ui name="user" size={12} /> {message.sender.name}</span>;
  if (message.viaCampaign) return <span className="chat-author campaign"><Ui name="megaphone" size={12} /> Campaña</span>;
  if (message.viaApi) return <span className="chat-author api"><Ui name="plug" size={12} /> API</span>;
  const kind = AUTHOR_LABELS[message.senderKind || 'bot'] || AUTHOR_LABELS.bot;
  return <span className={`chat-author ${message.senderKind || 'bot'}`}><Ui name={kind.icon} size={12} /> {kind.label}</span>;
}

// Igual que WhatsApp: ✓ enviado, ✓✓ gris entregado, ✓✓ azul leído.
function MessageTicks({ status }: { status: string }) {
  const map: Record<string, { text: string; title: string }> = {
    failed: { text: '!', title: 'No enviado' },
    pending: { text: '◷', title: 'Enviando…' },
    sent: { text: '✓', title: 'Enviado' },
    delivered: { text: '✓✓', title: 'Entregado' },
    read: { text: '✓✓', title: 'Leído' }
  };
  const item = map[status] || map.sent;
  return <span className={`chat-msg-ticks ${map[status] ? status : 'sent'}`} title={item.title}>{item.text}</span>;
}

function stageDotColor(conversation: Conversation) {
  const stage = deriveStage(conversation);
  return CRM_STAGES.find((item) => item.key === stage)?.color || '#64748b';
}

function MessageBody({ message }: { message: Message }) {
  if (message.contentType === 'poll') {
    try {
      const poll = JSON.parse(message.content) as { question: string; options: string[] };
      return (
        <div className="crm-poll-card">
          <div className="crm-poll-question"><Ui name="chart" size={16} /> {poll.question}</div>
          {poll.options.map((opt, idx) => (
            <div key={idx} className="crm-poll-option">○ {opt}</div>
          ))}
          <div className="crm-poll-hint">Encuesta de una sola opción</div>
        </div>
      );
    } catch {
      return <>{message.content}</>;
    }
  }
  if (message.contentType === 'contact') {
    try {
      const shared = JSON.parse(message.content) as { name: string; phone: string | null };
      return (
        <div className="crm-contact-card">
          <span className="crm-contact-card-icon"><Ui name="user" size={20} /></span>
          <div>
            <div className="crm-contact-card-name">{shared.name}</div>
            {shared.phone && <div className="crm-contact-card-phone">{formatPhone(shared.phone)}</div>}
          </div>
        </div>
      );
    } catch {
      return <>{message.content}</>;
    }
  }
  // Con adjunto no hace falta el título de relleno ("🖼️ Imagen", "Sticker", "Video"…), como en WhatsApp Web.
  if (message.attachment && MEDIA_PLACEHOLDERS.has(message.content.trim())) return null;
  if (message.contentType.endsWith('-failed') && MEDIA_PLACEHOLDERS.has(message.content.trim())) {
    return <em className="crm-media-failed">No se pudo descargar el archivo</em>;
  }
  return <RichText text={message.content} />;
}

/** Texto del audio debajo del reproductor (transcripción con Niro IA). */
function AudioTranscript({ message, autoEnabled, conversationId }: { message: Message; autoEnabled: boolean; conversationId: string }) {
  const { notify } = useAlerts();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const text = message.transcription?.trim() || '';
  const waiting = autoEnabled && message.direction === 'INBOUND' && !text && now - new Date(message.createdAt).getTime() < 90000;

  // Mientras se transcribe, revisamos el reloj para pasar a "Transcribir" si tarda demasiado.
  useEffect(() => {
    if (!waiting) return;
    const t = window.setTimeout(() => setNow(Date.now()), 5000);
    return () => window.clearTimeout(t);
  }, [waiting, now]);

  async function transcribe() {
    setBusy(true);
    try { await apiPost(`/api/org/conversations/${conversationId}/messages/${message.id}/ai-read`, {}); }
    catch (err) { notify(err instanceof ApiError ? err.message : 'No se pudo transcribir el audio', { tone: 'error' }); }
    finally { setBusy(false); }
  }

  if (text) {
    const long = text.length > 220;
    return (
      <div className="audio-transcript">
        <div className="audio-transcript-head"><span><Ui name="sparkles" size={12} /> Transcripción</span>
          <button type="button" onClick={() => { navigator.clipboard?.writeText(text); notify('Texto copiado', { tone: 'success' }); }} title="Copiar texto"><Ui name="copy" size={13} /></button></div>
        <p className={long && !expanded ? 'clamped' : ''}>{text}</p>
        {long && <button type="button" className="audio-transcript-more" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Ver menos' : 'Ver todo'}</button>}
      </div>
    );
  }
  if (waiting || busy) return <div className="audio-transcript pending"><span className="audio-transcript-dots"><i /><i /><i /></span> Transcribiendo…</div>;
  return <button type="button" className="audio-transcript-btn" onClick={transcribe}><Ui name="note" size={13} /> Transcribir</button>;
}

function AttachmentContent({
  message,
  conversationId,
  onOpenImage
}: {
  message: Message;
  conversationId: string;
  onOpenImage?: (url: string, fileName: string) => void;
}) {
  if (!message.attachment) return null;
  const url = `/api/org/conversations/${message.conversationId || conversationId}/attachments/${message.attachment.id}`;
  const mime = message.attachment.mimeType;

  if (message.contentType === 'sticker' || (mime === 'image/webp' && message.contentType.startsWith('sticker'))) {
    return <img src={url} alt="" className="crm-msg-sticker" loading="lazy" />;
  }
  if (mime.startsWith('image/')) {
    return (
      <div className="crm-msg-media-wrap">
        <img
          src={url}
          alt={message.attachment.fileName}
          className="crm-msg-image"
          onClick={() => onOpenImage?.(url, message.attachment?.fileName || 'imagen')}
          style={{ cursor: 'pointer', borderRadius: 8, maxWidth: '100%', maxHeight: 280, display: 'block' }}
          title="Clic para ampliar imagen"
        />
        <a href={url} download={message.attachment.fileName} className="crm-msg-download-btn" title="Descargar"><Ui name="download" size={16} /></a>
      </div>
    );
  }
  if (mime.startsWith('video/')) {
    return (
      <div className="crm-msg-media-wrap">
        <PlyrVideo src={url} />
        <a href={url} download={message.attachment.fileName} className="crm-msg-download-btn" title="Descargar"><Ui name="download" size={16} /></a>
      </div>
    );
  }
  if (mime.startsWith('audio/')) {
    return <WaveAudio src={url} outbound={message.direction === 'OUTBOUND'} />;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="crm-msg-document">
      <Ui name="note" size={20} />
      <span>{message.attachment.fileName}</span>
    </a>
  );
}

/* =========================================================
   CONTACT INFO PANEL (Column 3)
   ========================================================= */
function ContactInfoRail({
  conversation,
  onExpand
}: {
  conversation: Conversation;
  onExpand: () => void;
}) {
  const label = contactLabel(conversation.contact);

  const iconItems = [
    { icon: 'user' as UiIconName, label: 'Información del contacto' },
    { icon: 'tag' as UiIconName, label: 'Etapa y etiquetas CRM' },
    { icon: 'users' as UiIconName, label: 'Agentes' },
    { icon: 'zap' as UiIconName, label: 'Acciones rápidas' },
    { icon: 'note' as UiIconName, label: 'Notas del cliente' }
  ];

  return (
    <aside className="crm-info-rail" aria-label="Información del contacto minimizada">
      <button
        type="button"
        className="crm-info-rail-toggle"
        onClick={onExpand}
        title="Mostrar información del contacto"
        aria-label="Mostrar información del contacto"
      >
        <Ui name="chevron-left" size={16} />
      </button>

      <div className="crm-info-rail-avatar" title={label}>
        <Avatar contact={conversation.contact} size={32} />
      </div>

      <div className="crm-info-rail-divider" />

      {iconItems.map((item) => (
        <button
          key={item.label}
          type="button"
          className="crm-info-rail-icon"
          onClick={onExpand}
          title={`Mostrar ${item.label.toLowerCase()}`}
          aria-label={`Mostrar ${item.label}`}
        >
          <Ui name={item.icon} size={18} />
        </button>
      ))}
    </aside>
  );
}

function ContactInfoPanel({
  conversation,
  onConversationChange,
  onOpenTransfer,
  onOpenOrder,
  onEditContact,
  onClose
}: {
  conversation: Conversation;
  onConversationChange: (c: Conversation) => void;
  onOpenTransfer: () => void;
  onOpenOrder: () => void;
  onEditContact: () => void;
  onClose?: () => void;
}) {
  const [notes, setNotes] = useState<Message[]>([]);
  const [newNote, setNewNote] = useState('');
  const [showAddNote, setShowAddNote] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    apiGet<{ messages: Message[] }>(`/api/org/conversations/${conversation.id}/messages`)
      .then((d) => setNotes(d.messages.filter((m) => m.direction === 'NOTE')))
      .catch(() => {});
  }, [conversation.id]);

  async function handleAddNote(e: FormEvent) {
    e.preventDefault();
    if (!newNote.trim() || savingNote) return;
    setSavingNote(true);
    try {
      const res = await apiPost<{ message: Message }>(`/api/org/conversations/${conversation.id}/messages`, {
        content: newNote.trim(),
        type: 'note'
      });
      setNotes((prev) => [...prev, res.message]);
      setNewNote('');
      setShowAddNote(false);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingNote(false);
    }
  }

  async function handleMarkResolved() {
    setResolving(true);
    try {
      const res = await patchConversation(conversation, { status: 'RESOLVED' });
      if (res) onConversationChange(res.conversation);
    } catch (err) {
      console.error(err);
    } finally {
      setResolving(false);
    }
  }

  const [changingStage, setChangingStage] = useState(false);
  const { patchConversation, registerOutcome } = useOutcome();
  const currentStage = deriveStage(conversation);

  async function handleStageChange(e: ChangeEvent<HTMLSelectElement>) {
    const stage = e.target.value as CrmStage;
    if (stage === currentStage) return;
    setChangingStage(true);
    const nextTags = tagsForStage(conversation.tags, stage);
    const nextStatus = statusForStage(stage);
    try {
      // Pasar a "Cerradas" cierra la conversación: pide cómo terminó (venta, perdida, cotización…).
      const res = await patchConversation(conversation, { tags: nextTags, ...(nextStatus ? { status: nextStatus } : {}) });
      if (res) onConversationChange(res.conversation);
    } catch (err) {
      console.error(err);
    } finally {
      setChangingStage(false);
    }
  }

  const cleanPhone = isUsablePhone(conversation.contact.phone) ? phoneDigits(conversation.contact.phone) : null;

  return (
    <div className="crm-info-column">
      {/* Header */}
      <div className="crm-info-header">
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--text-main)' }}>
          Información del contacto
        </h3>
        <div className="crm-info-header-actions">
          {onClose && (
            <button
              type="button"
              className="crm-info-collapse-btn"
              onClick={onClose}
              title="Minimizar información del contacto"
              aria-label="Minimizar información del contacto"
            >
              ▶
            </button>
          )}
          <button
            type="button"
            className="crm-info-close-btn"
            onClick={onClose}
            title="Cerrar información del contacto"
            aria-label="Cerrar información del contacto"
          >
            <Ui name="x" size={16} />
          </button>
        </div>
      </div>

      {/* Profile Card */}
      <div className="crm-info-profile-card">
        <div className="crm-info-avatar-large">
          {conversation.contact.avatarUrl ? (
            <img
              src={conversation.contact.avatarUrl}
              alt={contactLabel(conversation.contact)}
              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 800, color: '#ffffff', background: 'linear-gradient(135deg, #0284c7 0%, #2563eb 100%)', borderRadius: '50%' }}>
              {initials(contactLabel(conversation.contact))}
            </div>
          )}
        </div>
        <div className="crm-info-name">{contactLabel(conversation.contact)}</div>

        <button
          type="button"
          className="btn secondary small"
          style={{ marginTop: 8, padding: '4px 12px', fontSize: 11.5 }}
          onClick={onEditContact}
        >
          <Ui name="edit" size={14} /> Editar contacto
        </button>

        <div className="field" style={{ width: '100%', marginTop: 10 }}>
          <label style={{ fontSize: 11 }}>Etapa CRM</label>
          <select className="input" value={currentStage} onChange={handleStageChange} disabled={changingStage}>
            {CRM_STAGES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </div>

        <div className="crm-contact-meta-list">
          {conversation.contact.phone && (
            <div className="crm-contact-meta-item">
              <Ui name="phone" size={14} /> {formatPhone(conversation.contact.phone)}
              {cleanPhone && (
                <a
                  href={`https://wa.me/${cleanPhone}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ marginLeft: 'auto', fontSize: 11, color: '#25d366', textDecoration: 'none', fontWeight: 700 }}
                >
                  WhatsApp <Ui name="external" size={12} />
                </a>
              )}
            </div>
          )}
          {conversation.contact.email && (
            <div className="crm-contact-meta-item">
              <Ui name="mail" size={14} /> {conversation.contact.email}
            </div>
          )}
        </div>

        {/* Tags */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
          {conversation.contact.tags.length === 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Sin etiquetas</span>
          )}
          {conversation.contact.tags.map((t) => (
            <span
              key={t}
              className="ai-quick-chip"
              style={{ background: 'var(--primary-soft)', color: 'var(--primary-text)', borderColor: 'var(--primary-glow)' }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* Agents list: drag a chat onto an agent to transfer it */}
      <AgentsDropPanel conversation={conversation} onConversationChange={onConversationChange} />

      {/* Quick Actions */}
      <div className="crm-quick-actions-box">
        <div className="crm-section-subtitle">Acciones rápidas</div>
        <button
          type="button"
          className="crm-quick-action-btn"
          onClick={onOpenTransfer}
        >
          <Ui name="transfer" size={18} /> Transferir conversación
        </button>
        <button
          type="button"
          className="crm-quick-action-btn"
          onClick={onOpenTransfer}
        >
          <Ui name="user-plus" size={18} /> Asignar agente
        </button>
        <button
          type="button"
          className="crm-quick-action-btn"
          onClick={onOpenOrder}
        >
          <Ui name="cart" size={18} /> Crear pedido / cotización
        </button>
        <button
          type="button"
          className="crm-quick-action-btn"
          onClick={() => { void registerOutcome(conversation); }}
          title="Registrá una cotización enviada, una venta u otro avance sin cerrar el chat"
        >
          <Ui name="chart" size={18} /> Registrar gestión
        </button>
        <button
          type="button"
          className="crm-quick-action-btn"
          onClick={handleMarkResolved}
          disabled={resolving || conversation.status === 'RESOLVED'}
        >
          <Ui name="check-circle" size={18} /> {conversation.status === 'RESOLVED' ? 'Resuelta' : resolving ? 'Marcando...' : 'Marcar como resuelto'}
        </button>
      </div>

      {/* Notes */}
      <div className="crm-quick-actions-box">
        <div className="crm-section-subtitle">Notas del cliente ({notes.length})</div>
        {notes.length === 0 && !showAddNote && (
          <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 8px' }}>Sin notas todavía.</p>
        )}
        {notes.map((note) => (
          <div key={note.id} style={{ fontSize: 12.5, color: 'var(--text-main)', background: 'var(--bg-surface-2)', padding: '8px 10px', borderRadius: 10, marginBottom: 8 }}>
            <RichText text={note.content} />
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
              {(note.sender && note.sender.name) || 'Agente'} · {formatTime(note.createdAt)}
            </div>
          </div>
        ))}

        {showAddNote ? (
          <form onSubmit={handleAddNote}>
            <textarea
              className="topbar-search-input"
              style={{ width: '100%', borderRadius: 10, padding: 8, fontSize: 12 }}
              placeholder="Escribe una nota interna..."
              rows={2}
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button type="submit" className="btn small" style={{ flex: 1 }} disabled={savingNote}>{savingNote ? 'Guardando...' : 'Guardar'}</button>
              <button type="button" className="btn secondary small" onClick={() => setShowAddNote(false)}>Cancelar</button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="crm-quick-action-btn"
            style={{ justifyContent: 'center', marginTop: 6 }}
            onClick={() => setShowAddNote(true)}
          >
            + Agregar nota
          </button>
        )}
      </div>
    </div>
  );
}

/* =========================================================
   FORWARD MESSAGE MODAL (WhatsApp Web Style)
   ========================================================= */
function ForwardMessageModal({
  message,
  conversations,
  onClose,
  onForwarded
}: {
  message: Message;
  conversations: Conversation[];
  onClose: () => void;
  onForwarded: (targetConversationId: string) => void;
}) {
  const { notify } = useAlerts();
  const [targetId, setTargetId] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [forwarding, setForwarding] = useState(false);

  const filtered = conversations.filter((c) => {
    const label = contactLabel(c.contact).toLowerCase();
    const phone = (c.contact.phone || '').toLowerCase();
    const term = searchTerm.toLowerCase().trim();
    return label.includes(term) || phone.includes(term);
  });

  async function handleForward() {
    if (!targetId || forwarding) return;
    setForwarding(true);
    try {
      await apiPost(`/api/org/conversations/${targetId}/messages`, {
        content: `➡️ [Reenviado]: ${message.content || '[Archivo adjunto]'}`,
        type: 'outbound'
      });
      onForwarded(targetId);
    } catch (err) {
      console.error(err);
      notify('No se pudo reenviar el mensaje.', { tone: 'error', title: 'Error al reenviar' });
    } finally {
      setForwarding(false);
    }
  }

  return (
    <Modal title="Reenviar mensaje" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: 'var(--bg-surface-2)', padding: 12, borderRadius: 10, fontSize: 13, borderLeft: '3px solid var(--primary-glow)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>Mensaje a reenviar:</div>
          <div style={{ color: 'var(--text-main)', fontStyle: 'italic' }}>{message.content || '[Archivo adjunto]'}</div>
        </div>

        <input
          className="topbar-search-input"
          placeholder="Buscar contacto o conversación..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map((c) => {
            const isSelected = targetId === c.id;
            return (
              <div
                key={c.id}
                onClick={() => setTargetId(c.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 12px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  background: isSelected ? 'var(--primary-soft)' : 'var(--bg-surface)',
                  border: isSelected ? '1px solid var(--primary-glow)' : '1px solid var(--border-subtle)'
                }}
              >
                <Avatar contact={c.contact} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-main)' }}>{contactLabel(c.contact)}</div>
                  {c.contact.phone && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{formatPhone(c.contact.phone)}</div>}
                </div>
                {isSelected && <Ui name="check" size={16} style={{ color: 'var(--primary-glow)' }} />}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button type="button" className="btn secondary" onClick={onClose} disabled={forwarding}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={handleForward} disabled={!targetId || forwarding}>
            {forwarding ? 'Reenviando...' : 'Reenviar mensaje'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* =========================================================
   EDIT CONTACT MODAL
   ========================================================= */
function EditContactModal({
  contact,
  onClose,
  onSaved
}: {
  contact: Contact;
  onClose: () => void;
  onSaved: (updatedContact: Contact) => void;
}) {
  const { notify } = useAlerts();
  const { user } = useAuth();
  const canEditConsent = user ? ['OWNER', 'ADMIN', 'SUPERVISOR'].includes(user.role) : false;
  const initialConsent = contact.callOptedOutAt ? 'REVOKED' : (contact.callConsentStatus || 'UNKNOWN');
  const [consent, setConsent] = useState(initialConsent);
  const [name, setName] = useState(contact.name || '');
  const [phone, setPhone] = useState(contact.phone || '');
  const [email, setEmail] = useState(contact.email || '');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiPatch<{ contact: Contact }>(`/api/org/contacts/${contact.id}`, {
        name: name.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        ...(canEditConsent && consent !== initialConsent
          ? {
              callConsentStatus: consent === 'REVOKED' ? 'REVOKED' : consent,
              callConsentAt: consent === 'GRANTED' ? new Date().toISOString() : null,
              callConsentSource: `Registrado manualmente por ${user?.name || 'un usuario'}`,
              // Granting clears any previous opt-out; revoking records it.
              callOptedOutAt: consent === 'REVOKED' ? new Date().toISOString() : null,
              callOptOutSource: consent === 'REVOKED' ? `Registrado manualmente por ${user?.name || 'un usuario'}` : null
            }
          : {})
      });
      onSaved(res.contact);
    } catch (err) {
      console.error(err);
      notify('No se pudo actualizar el contacto.', { tone: 'error', title: 'Error al actualizar' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Editar contacto" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="field">
          <label>Nombre del cliente</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: María González"
          />
        </div>
        <div className="field">
          <label>Número de WhatsApp / Teléfono</label>
          <input
            className="input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Ej: 595994854167"
          />
        </div>
        <div className="field">
          <label>Correo electrónico (opcional)</label>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Ej: maria@ejemplo.com"
          />
        </div>
        {canEditConsent && (
          <div className="field">
            <label>Consentimiento para llamadas de WhatsApp</label>
            <select className="input" value={consent} onChange={(e) => setConsent(e.target.value)}>
              <option value="UNKNOWN">Sin registro (no se le llamará en campañas)</option>
              <option value="GRANTED">Autorizado a recibir llamadas</option>
              <option value="DENIED">Rechazó las llamadas</option>
              <option value="REVOKED">Pidió no recibir más llamadas</option>
            </select>
            <small style={{ opacity: 0.7 }}>Solo los contactos autorizados entran en campañas de llamadas. Marcá esta opción únicamente si el cliente aceptó ser llamado.</small>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button type="button" className="btn secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="btn" disabled={saving}>
            {saving ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* =========================================================
   TRANSFER CHAT MODAL
   ========================================================= */
function TransferConversationModal({
  conversation,
  onClose,
  onTransferred
}: {
  conversation: Conversation;
  onClose: () => void;
  onTransferred: (c: Conversation) => void;
}) {
  const { notify } = useAlerts();
  const [agents, setAgents] = useState<OrgUser[]>([]);
  const [presence, setPresence] = useState<AgentPresence[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedDeptId, setSelectedDeptId] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ users: OrgUser[] }>('/api/org/users').then((d) => setAgents(d.users)).catch(() => {});
    apiGet<{ departments: Department[] }>('/api/org/departments').then((d) => setDepartments(d.departments)).catch(() => {});
    apiGet<{ presence: AgentPresence[] }>('/api/org/presence').then((d) => setPresence(d.presence)).catch(() => {});

    const socket = getSocket();
    const onPresence = ({ presence: list }: { presence: AgentPresence[] }) => setPresence(list);
    socket.on('agent:presence_list', onPresence);
    return () => {
      socket.off('agent:presence_list', onPresence);
    };
  }, []);

  function statusFor(agentId: string): AgentPresenceStatus {
    return presence.find((p) => p.userId === agentId)?.status || 'offline';
  }

  async function handleTransfer(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await apiPost<{ conversation: Conversation }>(`/api/org/conversations/${conversation.id}/transfer`, {
        targetUserId: selectedAgentId || null,
        departmentId: selectedDeptId || null,
        note: transferNote.trim() || null
      });
      onTransferred(res.conversation);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'No se pudo transferir. Volvé a intentar.', { tone: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Transferir Conversación" onClose={onClose}>
      <form onSubmit={handleTransfer}>
        <div className="field">
          <label>Transferir a Departamento</label>
          <select
            className="input"
            value={selectedDeptId}
            onChange={(e) => setSelectedDeptId(e.target.value)}
          >
            <option value="">Seleccionar departamento...</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Agentes ({presence.filter((p) => p.online).length} en línea)</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
            {agents.map((a) => {
              const status = statusFor(a.id);
              const selected = selectedAgentId === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedAgentId(selected ? '' : a.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderRadius: 10,
                    border: `1px solid ${selected ? 'var(--primary-glow)' : 'var(--border-color)'}`,
                    background: selected ? 'var(--primary-soft)' : 'var(--bg-surface-2)',
                    color: 'var(--text-main)',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: PRESENCE_COLOR[status], flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{a.name} <span style={{ opacity: 0.6, fontWeight: 400 }}>({a.role})</span></span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{PRESENCE_LABEL[status]}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label>Nota de Transferencia (Contexto para el agente)</label>
          <textarea
            className="input"
            rows={2}
            placeholder="Contexto para quien reciba la conversación..."
            value={transferNote}
            onChange={(e) => setTransferNote(e.target.value)}
          />
        </div>

        <button
          type="submit"
          className="btn"
          disabled={submitting || (!selectedAgentId && !selectedDeptId)}
          style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
        >
          {submitting ? 'Transfiriendo...' : <>Confirmar Transferencia <Ui name="arrow-right" size={14} /></>}
        </button>
      </form>
    </Modal>
  );
}

/* =========================================================
   CREATE ORDER & QUOTE MODAL
   ========================================================= */
function CreateOrderModal({
  conversation,
  onClose,
  onCreated
}: {
  conversation: Conversation;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [productName, setProductName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState(0);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleCreateOrder(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiPost('/api/org/orders', {
        contactId: conversation.contact.id,
        conversationId: conversation.id,
        notes,
        items: [
          {
            name: productName,
            quantity: Number(quantity),
            unitPrice: Number(price)
          }
        ]
      });
      // Send bot confirmation message in chat
      await apiPost(`/api/org/conversations/${conversation.id}/messages`, {
        content: `📦 Cotización/Pedido generado:\n${productName} x ${quantity} unid. = Gs. ${(quantity * price).toLocaleString('es-PY')}\nEstado: Recibido en preparación.`,
        type: 'outbound'
      });
      onCreated();
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Crear Pedido / Cotización" onClose={onClose}>
      <form onSubmit={handleCreateOrder}>
        <div className="field">
          <label>Producto o Servicio</label>
          <input
            className="input"
            required
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="field">
            <label>Cantidad</label>
            <input
              type="number"
              min={1}
              className="input"
              required
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>Precio Unitario (Gs.)</label>
            <input
              type="number"
              min={0}
              className="input"
              required
              value={price}
              onChange={(e) => setPrice(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="field">
          <label>Total Estimado</label>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--primary-glow)', padding: '6px 0' }}>
            Gs. {(quantity * price).toLocaleString('es-PY')}
          </div>
        </div>

        <div className="field">
          <label>Observaciones de Entrega</label>
          <textarea
            className="input"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <button
          type="submit"
          className="btn"
          disabled={submitting}
          style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
        >
          {submitting ? 'Registrando...' : <>Generar Pedido y Enviar a WhatsApp <Ui name="arrow-right" size={14} /></>}
        </button>
      </form>
    </Modal>
  );
}

/* =========================================================
   NEW CONVERSATION MODAL
   ========================================================= */
function NewConversationModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Conversation) => void }) {
  const { notify } = useAlerts();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ departments: Department[] }>('/api/org/departments').then((data) => setDepartments(data.departments)).catch(() => setDepartments([]));
  }, []);

  useEffect(() => {
    if (!query.trim() || selectedContact) { setResults([]); return; }
    setSearching(true);
    const id = setTimeout(() => {
      apiGet<{ contacts: Contact[] }>(`/api/org/contacts?q=${encodeURIComponent(query.trim())}&limit=8`)
        .then((data) => setResults(data.contacts.filter((c) => c.phone)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(id);
  }, [query, selectedContact]);

  const phoneDigitsNew = newPhone.replace(/\D/g, '');
  const canSubmit = Boolean(selectedContact) || (creatingNew && phoneDigitsNew.length >= 8);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { departmentId: departmentId || undefined, channel: 'whatsapp' };
      if (selectedContact) body.contactId = selectedContact.id;
      else body.newContact = { name: newName.trim() || undefined, phone: phoneDigitsNew };

      const data = await apiPost<{ conversation: Conversation; existing?: boolean }>('/api/org/conversations', body);
      if (data.existing) notify(`Ya tenías un chat con ${contactLabel(data.conversation.contact)}: lo abrimos.`, { tone: 'info' });
      if (firstMessage.trim()) {
        try { await apiPost(`/api/org/conversations/${data.conversation.id}/messages`, { content: firstMessage.trim(), type: 'outbound' }); }
        catch { notify('El chat se creó, pero no se pudo enviar el primer mensaje. Escribilo desde el chat.', { tone: 'warning' }); }
      }
      onCreated(data.conversation);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear el chat. Revisá los datos e intentá de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Nuevo chat de WhatsApp" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Iniciá una conversación con un cliente. Se abre un chat de WhatsApp <b>a tu nombre</b> y podés escribir el primer mensaje ahora mismo.
        </p>

        {!creatingNew && (
          <div className="field">
            <label>¿Con quién querés hablar?</label>
            {selectedContact ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, background: 'var(--bg-surface-2)', padding: '10px 12px', borderRadius: 10 }}>
                <span style={{ display: 'flex', flexDirection: 'column' }}><b>{contactLabel(selectedContact)}</b><small style={{ color: 'var(--text-muted)' }}>{formatPhone(selectedContact.phone)}</small></span>
                <button type="button" className="btn secondary small" onClick={() => setSelectedContact(null)}>Cambiar</button>
              </div>
            ) : (
              <>
                <input className="input" placeholder="Buscar por nombre o teléfono…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
                {results.length > 0 && (
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, marginTop: 6, overflow: 'hidden', maxHeight: 220, overflowY: 'auto' }}>
                    {results.map((c) => (
                      <button type="button" key={c.id} onClick={() => setSelectedContact(c)} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '9px 12px', border: 0, borderBottom: '1px solid var(--border-color)', background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                        <Avatar contact={c} size={32} />
                        <span style={{ display: 'flex', flexDirection: 'column' }}><b style={{ fontSize: 13.5 }}>{contactLabel(c)}</b><small style={{ color: 'var(--text-muted)' }}>{formatPhone(c.phone)}</small></span>
                      </button>
                    ))}
                  </div>
                )}
                {query.trim() && !searching && results.length === 0 && <small style={{ display: 'block', marginTop: 6, color: 'var(--text-muted)' }}>No hay contactos con esa búsqueda. Podés cargarlo como contacto nuevo.</small>}
              </>
            )}
          </div>
        )}

        {!selectedContact && (
          <button type="button" className="btn secondary small" onClick={() => { setCreatingNew((v) => !v); setError(null); }} style={{ marginBottom: 14 }}>
            {creatingNew ? 'Buscar entre mis contactos' : '+ Cargar contacto nuevo'}
          </button>
        )}

        {creatingNew && !selectedContact && (
          <>
            <div className="field"><label>Nombre (opcional)</label><input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus /></div>
            <div className="field">
              <label>Número de WhatsApp</label>
              <input className="input" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="595981123456" inputMode="tel" />
              <small style={{ color: 'var(--text-muted)' }}>Con código de país y sin el +. Ej.: 595981123456</small>
            </div>
          </>
        )}

        <div className="field">
          <label>Primer mensaje (opcional)</label>
          <textarea className="input" rows={3} value={firstMessage} onChange={(e) => setFirstMessage(e.target.value)} placeholder="Hola, te escribo de…" maxLength={4000} />
        </div>

        <div className="field">
          <label>Departamento (opcional)</label>
          <select className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Sin departamento</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>

        {error && <div className="alert error" style={{ marginBottom: 10 }}>{error}</div>}
        <button className="btn" type="submit" disabled={!canSubmit || submitting} style={{ width: '100%', justifyContent: 'center' }}>
          {submitting ? 'Creando…' : firstMessage.trim() ? 'Crear chat y enviar mensaje' : 'Abrir chat'}
        </button>
      </form>
    </Modal>
  );
}
