import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, apiUpload, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { contactLabel, formatPhone, formatTime, initials, isUsablePhone, phoneDigits } from '../lib/format';
import { CRM_STAGES, deriveStage, statusForStage, tagsForStage, type CrmStage } from '../lib/crmStage';
import { Modal } from '../components/Modal';
import { AgentsDropPanel, setConversationDragData } from '../components/AgentsDropPanel';
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
const EXTENDED_EMOJIS = [
  '👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉',
  '👏', '💯', '🥳', '🚀', '🙌', '🤝', '💔', '😴',
  '🤖', '🛒', '📦', '⭐', '✨', '⚡', '💡', '✅',
  '❌', '😍', '🤩', '😎', '🤔', '🙄', '🤫', '🥺',
  '😭', '🤯', '🤗', '🤓', '😇', '🤠', '😷', '💪',
  '👀', '💬', '📞', '📍', '💰', '🏷️', '📋', '🛍️'
];
const COMPOSER_EMOJIS = ['😀', '😂', '😍', '👍', '🙏', '🎉', '❤️', '😢', '😮', '🔥', '✅', '❌'];

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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [tab, setTab] = useState<ConvFilterTab>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [forwardMessage, setForwardMessage] = useState<Message | null>(null);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [floatingToast, setFloatingToast] = useState<string | null>(null);
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
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ url: string; fileName: string } | null>(null);
  const [incomingTransfer, setIncomingTransfer] = useState<{ conversation: Conversation; fromAgent: string; note: string | null } | null>(null);
  const [respondingTransfer, setRespondingTransfer] = useState(false);

  function showToast(msg: string) {
    setFloatingToast(msg);
    setTimeout(() => setFloatingToast(null), 3000);
  }

  function toggleStarMessage(msgId: string) {
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
        showToast('Mensaje quitado de destacados');
      } else {
        next.add(msgId);
        showToast('⭐ Mensaje guardado en destacados');
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
      const next = idx === -1 ? [conversation, ...prev] : prev.map((c) => (c.id === conversation.id ? conversation : c));
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
      if (data.conversations.length > 0 && !selectedId) {
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

  useEffect(() => {
    const socket = getSocket();
    const onNew = ({ conversation }: { conversation: Conversation }) => upsertConversation(conversation);
    const onUpdated = ({ conversation }: { conversation: Conversation }) => upsertConversation(conversation);
    const onTransferIncoming = (payload: { conversation: Conversation; fromAgent: string; note: string | null }) => {
      upsertConversation(payload.conversation);
      setIncomingTransfer(payload);
    };
    socket.on('conversation:new', onNew);
    socket.on('conversation:updated', onUpdated);
    socket.on('transfer:incoming', onTransferIncoming);
    return () => {
      socket.off('conversation:new', onNew);
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
      if (action === 'accept') setSelectedId(res.conversation.id);
    } catch (err) {
      console.error(err);
    } finally {
      setRespondingTransfer(false);
      setIncomingTransfer(null);
    }
  }

  const filteredConversations = conversations.filter((c) => {
    if (tab === 'clients') return c.channel !== 'internal';
    if (tab === 'internal') return c.channel === 'internal';
    return true;
  });

  const selected = filteredConversations.find((c) => c.id === selectedId) || filteredConversations[0] || null;

  const gridTemplate = leftCollapsed
    ? rightCollapsed
      ? '1fr'
      : '1fr 340px'
    : rightCollapsed
    ? '320px 1fr'
    : '320px 1fr 340px';

  return (
    <div className="crm-inbox-grid" style={{ gridTemplateColumns: gridTemplate }}>
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
                  ◀
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
              <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', opacity: 0.5, fontSize: 13 }}>
                🔍
              </span>
            </div>
          </div>

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
                  className={`crm-conv-item ${isSelected ? 'active' : ''}`}
                  onClick={() => setSelectedId(c.id)}
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
                          📞 {formatPhone(c.contact.phone)}
                        </span>
                      ) : null}
                      <span style={{ color: 'var(--text-dim)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.subject || 'Sin asunto'}
                      </span>
                    </div>

                    <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <StageBadge conversation={c} />
                      {c.assignedTo && (
                        <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                          👤 {c.assignedTo.name.split(' ')[0]}
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

      {/* =========================================================
          COLUMN 2: ACTIVE CHAT WINDOW
          ========================================================= */}
      <div className="crm-chat-column">
        {selected ? (
          <ActiveChatWindow
            conversation={selected}
            onConversationChange={upsertConversation}
            onOpenTransfer={() => setShowTransferModal(true)}
            onOpenOrder={() => setShowOrderModal(true)}
            onOpenImage={(url, fileName) => setLightboxImage({ url, fileName })}
            leftCollapsed={leftCollapsed}
            onToggleLeft={() => setLeftCollapsed((v) => !v)}
            rightCollapsed={rightCollapsed}
            onToggleRight={() => setRightCollapsed((v) => !v)}
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
      {selected && !rightCollapsed && (
        <ContactInfoPanel
          conversation={selected}
          onConversationChange={upsertConversation}
          onOpenTransfer={() => setShowTransferModal(true)}
          onOpenOrder={() => setShowOrderModal(true)}
          onEditContact={() => setEditingContact(selected.contact)}
          onClose={() => setRightCollapsed(true)}
        />
      )}

      {/* Incoming transfer banner */}
      {incomingTransfer && (
        <div className="crm-transfer-banner">
          <div>
            <strong>🔄 Nueva conversación transferida</strong>
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
            showToast('✅ Mensaje reenviado con éxito');
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
            showToast('✅ Contacto actualizado correctamente');
          }}
        />
      )}

      {/* Floating Toast Notification */}
      {floatingToast && (
        <div className="crm-floating-toast">
          <span>ℹ️</span>
          <span>{floatingToast}</span>
        </div>
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
          ⬇️ Descargar
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
          ✕
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [mode, setMode] = useState<'outbound' | 'note' | 'inbound'>('outbound');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [changingStage, setChangingStage] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [extendedEmojiFor, setExtendedEmojiFor] = useState<Message | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showPollModal, setShowPollModal] = useState(false);
  const [showContactShareModal, setShowContactShareModal] = useState(false);
  const [showCameraModal, setShowCameraModal] = useState(false);
  const [recording, setRecording] = useState(false);
  const [respondingTransfer, setRespondingTransfer] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const currentStage = deriveStage(conversation);

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
      const res = await apiPatch<{ conversation: Conversation }>(`/api/org/conversations/${conversation.id}`, {
        tags: nextTags,
        ...(nextStatus ? { status: nextStatus } : {})
      });
      onConversationChange(res.conversation);
    } catch (err) {
      console.error(err);
    } finally {
      setChangingStage(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    apiGet<{ messages: Message[] }>(`/api/org/conversations/${conversation.id}`)
      .then((data) => setMessages(data.messages))
      .catch(() => {})
      .finally(() => setLoading(false));
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
      console.error(err);
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
    if (!window.confirm('¿Eliminar este mensaje? Si el chat es de WhatsApp, también se borrará para el cliente.')) return;
    try {
      await apiDelete(`/api/org/conversations/${conversation.id}/messages/${message.id}`);
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
      showToast('🗑️ Mensaje eliminado');
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
      await apiUpload(`/api/org/conversations/${conversation.id}/attachments`, formData);
    } catch (err) {
      console.error(err);
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
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        uploadFile(blob, `nota-de-voz-${Date.now()}.webm`, true);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      console.error(err);
      alert('No se pudo acceder al micrófono. Revisá los permisos del navegador.');
    }
  }

  async function handleTransferResponse(action: 'accept' | 'reject') {
    setRespondingTransfer(true);
    try {
      const res = await apiPost<{ conversation: Conversation; accepted: boolean }>(
        `/api/org/conversations/${conversation.id}/transfer-response`,
        { action }
      );
      onConversationChange(res.conversation);
    } catch (e) {
      console.error(e);
    } finally {
      setRespondingTransfer(false);
    }
  }

  const cleanPhone = isUsablePhone(conversation.contact.phone) ? phoneDigits(conversation.contact.phone) : null;

  // Check if latest message is a transfer note
  const lastTransferNote = messages
    .filter((m) => m.direction === 'NOTE' && m.content.includes('[TRANSFERENCIA]'))
    .slice(-1)[0];

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
              ▶
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
                    📞 {formatPhone(conversation.contact.phone)}
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
                    WhatsApp ↗
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
              <option key={s.key} value={s.key}>📋 {s.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="composer-action-btn"
            title="Transferir chat a otro agente"
            onClick={onOpenTransfer}
          >
            🔄
          </button>
          <button
            type="button"
            className="composer-action-btn"
            title="Crear pedido"
            onClick={onOpenOrder}
          >
            🛒
          </button>
          <button
            type="button"
            className="composer-action-btn"
            title={rightCollapsed ? 'Mostrar información del contacto' : 'Ocultar panel lateral'}
            onClick={onToggleRight}
            style={!rightCollapsed ? { background: 'var(--primary-soft)', color: 'var(--primary-glow)' } : undefined}
          >
            ℹ️
          </button>
        </div>
      </div>

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
            <strong style={{ color: 'var(--primary-glow)' }}>🔄 Transferencia: </strong>
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
              ✓ Aceptar
            </button>
            <button
              type="button"
              className="btn secondary small"
              disabled={respondingTransfer}
              onClick={() => handleTransferResponse('reject')}
              style={{ color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.4)', fontSize: 11.5, padding: '4px 10px' }}
            >
              ✕ Rechazar
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
            <div key={m.id} className={`chat-bubble-container ${m.direction.toLowerCase()}`}>
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
                    ➕
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
                        <span>↩️</span> Responder
                      </button>
                      <button
                        type="button"
                        className="crm-wa-menu-item"
                        onClick={() => {
                          setExtendedEmojiFor(m);
                          setMenuOpenFor(null);
                        }}
                      >
                        <span>😊</span> Reaccionar
                      </button>
                      <button
                        type="button"
                        className="crm-wa-menu-item"
                        onClick={() => {
                          onOpenForward(m);
                          setMenuOpenFor(null);
                        }}
                      >
                        <span>➡️</span> Reenviar
                      </button>
                      {m.content && (
                        <button
                          type="button"
                          className="crm-wa-menu-item"
                          onClick={() => {
                            navigator.clipboard.writeText(m.content);
                            showToast('📋 Texto copiado al portapapeles');
                            setMenuOpenFor(null);
                          }}
                        >
                          <span>📋</span> Copiar texto
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
                        <span>⭐</span> {isStarred ? 'Quitar de destacados' : 'Destacar mensaje'}
                      </button>
                      <div className="crm-wa-menu-divider" />
                      {m.direction !== 'INBOUND' && (
                        <button
                          type="button"
                          className="crm-wa-menu-item"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => handleDeleteMessage(m)}
                        >
                          <span>🗑️</span> Eliminar mensaje
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
                        <span>🔄</span> Transferir chat
                      </button>
                      <button
                        type="button"
                        className="crm-wa-menu-item"
                        onClick={() => {
                          onOpenOrder();
                          setMenuOpenFor(null);
                        }}
                      >
                        <span>🛒</span> Crear pedido
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
                <AiReadPanel message={m} conversationId={conversation.id} />
                <MessageBody message={m} />
              </div>

              {/* Reaction Chips (WhatsApp Web Style) */}
              {(mine || otherReactions.length > 0) && (
                <div className="crm-reaction-row">
                  {mine && (
                    <span
                      className="crm-reaction-chip mine"
                      title="Tu reacción (clic para quitar)"
                      onClick={() => handleReact(m, null)}
                    >
                      {mine}
                    </span>
                  )}
                  {otherReactions.map((r, idx) => (
                    <span key={idx} className="crm-reaction-chip" title={`Reacción del ${r.from === 'customer' ? 'cliente' : 'agente'}`}>
                      {r.emoji}
                    </span>
                  ))}
                </div>
              )}

              {/* Bubble Meta (Time, Starred icon, Delivery status) */}
              <div className="chat-bubble-meta" style={m.direction === 'OUTBOUND' ? { alignSelf: 'flex-end' } : {}}>
                {isStarred && <span title="Mensaje destacado" style={{ color: '#f59e0b', fontSize: 11 }}>⭐</span>}
                {m.direction === 'NOTE' ? 'Nota interna' : m.direction === 'INBOUND' ? 'Cliente' : m.sender?.name || 'Agente'} · {formatTime(m.createdAt)}
                {m.direction === 'OUTBOUND' && <span style={{ color: '#38bdf8', marginLeft: 2 }}>✓✓</span>}
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
            <div className="crm-extended-emoji-grid">
              {EXTENDED_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="crm-extended-emoji-btn"
                  onClick={() => handleReact(extendedEmojiFor, emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
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
          <button type="button" onClick={() => setReplyTo(null)}>✕</button>
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
          📝
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
          📎
        </button>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="composer-action-btn"
            onClick={() => setShowMoreMenu((v) => !v)}
            title="Más opciones"
          >
            ➕
          </button>
          {showMoreMenu && (
            <div className="crm-emoji-picker composer" style={{ flexDirection: 'column', minWidth: 170, alignItems: 'stretch', padding: 6 }}>
              <button
                type="button"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 13, padding: '7px 8px' }}
                onClick={() => { setShowMoreMenu(false); setShowPollModal(true); }}
              >
                📊 Crear encuesta
              </button>
              <button
                type="button"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 13, padding: '7px 8px' }}
                onClick={() => { setShowMoreMenu(false); setShowContactShareModal(true); }}
              >
                📇 Compartir contacto
              </button>
              <button
                type="button"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 13, padding: '7px 8px' }}
                onClick={() => { setShowMoreMenu(false); setShowCameraModal(true); }}
              >
                📷 Tomar foto
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className={`composer-action-btn ${recording ? 'recording' : ''}`}
          onClick={handleToggleRecording}
          title={recording ? 'Detener y enviar nota de voz' : 'Grabar nota de voz'}
        >
          {recording ? '⏹️' : '🎙️'}
        </button>

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="composer-action-btn"
            onClick={() => setShowEmojiPicker((v) => !v)}
            title="Insertar emoji"
          >
            😊
          </button>
          {showEmojiPicker && (
            <div className="crm-emoji-picker composer">
              {COMPOSER_EMOJIS.map((e) => (
                <button key={e} type="button" onClick={() => { setContent((prev) => prev + e); setShowEmojiPicker(false); }}>{e}</button>
              ))}
            </div>
          )}
        </div>

        <input
          className="crm-chat-input"
          placeholder={
            mode === 'note'
              ? 'Escribir nota interna para el equipo...'
              : recording
                ? 'Grabando nota de voz...'
                : 'Escribe un mensaje...'
          }
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={recording}
        />

        <button className="btn-send-message" type="submit" disabled={sending || recording || !content.trim()}>
          ➤
        </button>
      </form>

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
            {capturing ? 'Capturando...' : '📷 Capturar y enviar'}
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
                <button type="button" className="btn secondary small" onClick={() => removeOption(idx)}>✕</button>
              )}
            </div>
          ))}
          {options.length < 12 && (
            <button type="button" className="btn secondary small" onClick={addOption}>+ Agregar opción</button>
          )}
        </div>

        {error && <p style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</p>}

        <button type="submit" className="btn" disabled={submitting} style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>
          {submitting ? 'Enviando...' : 'Enviar encuesta →'}
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

function MessageBody({ message }: { message: Message }) {
  if (message.contentType === 'poll') {
    try {
      const poll = JSON.parse(message.content) as { question: string; options: string[] };
      return (
        <div className="crm-poll-card">
          <div className="crm-poll-question">📊 {poll.question}</div>
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
          <span className="crm-contact-card-icon">👤</span>
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
  return <>{message.content}</>;
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
  const url = `/api/org/conversations/${conversationId}/attachments/${message.attachment.id}`;
  const mime = message.attachment.mimeType;

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
        <a href={url} download={message.attachment.fileName} className="crm-msg-download-btn" title="Descargar">⬇️</a>
      </div>
    );
  }
  if (mime.startsWith('video/')) {
    return (
      <div className="crm-msg-media-wrap">
        <video
          src={url}
          controls
          className="crm-msg-video"
          preload="metadata"
          style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 8, marginTop: 4 }}
        />
        <a href={url} download={message.attachment.fileName} className="crm-msg-download-btn" title="Descargar">⬇️</a>
      </div>
    );
  }
  if (mime.startsWith('audio/')) {
    return (
      <audio
        src={url}
        controls
        className="crm-msg-audio"
        style={{ width: '100%', minWidth: 220, marginTop: 4 }}
      />
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="crm-msg-document">
      <span>📄</span>
      <span>{message.attachment.fileName}</span>
    </a>
  );
}

/**
 * Botón "Leer con IA" bajo un audio o una imagen que todavía no fue procesado, y el resultado
 * (transcripción o texto detectado) una vez que ya lo fue. Se pide a mano, no automático, para
 * no gastar créditos de IA en cada adjunto sin que el agente lo necesite.
 */
function AiReadPanel({ message, conversationId }: { message: Message; conversationId: string }) {
  const [transcription, setTranscription] = useState(message.transcription);
  const [loading, setLoading] = useState<'text' | 'invoice' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setTranscription(message.transcription), [message.transcription]);

  if (!message.attachment) return null;
  const isAudio = message.attachment.mimeType.startsWith('audio/');
  const isImage = message.attachment.mimeType.startsWith('image/');
  if (!isAudio && !isImage) return null;

  async function runAiRead(mode?: 'invoice') {
    setLoading(mode || 'text');
    setError(null);
    try {
      const res = await apiPost<{ message: Message }>(
        `/api/org/conversations/${conversationId}/messages/${message.id}/ai-read`,
        mode ? { mode } : {}
      );
      setTranscription(res.message.transcription);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo leer con IA');
    } finally {
      setLoading(null);
    }
  }

  if (transcription) {
    return (
      <div className="crm-ai-transcript">
        <span className="crm-ai-transcript-label">{isAudio ? '🎤 Transcripción' : '🔎 Texto detectado'}</span>
        <p>{transcription}</p>
      </div>
    );
  }

  return (
    <div className="crm-ai-read-actions">
      <button type="button" className="crm-ai-read-btn" disabled={!!loading} onClick={() => runAiRead()}>
        {loading === 'text' ? 'Leyendo…' : isAudio ? '🎤 Transcribir con IA' : '🔎 Leer texto con IA'}
      </button>
      {isImage && (
        <button type="button" className="crm-ai-read-btn" disabled={!!loading} onClick={() => runAiRead('invoice')}>
          {loading === 'invoice' ? 'Leyendo…' : '🧾 Leer como factura'}
        </button>
      )}
      {error && <span className="crm-ai-read-error">{error}</span>}
    </div>
  );
}

/* =========================================================
   CONTACT INFO PANEL (Column 3)
   ========================================================= */
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
      const res = await apiPatch<{ conversation: Conversation }>(`/api/org/conversations/${conversation.id}`, {
        status: 'RESOLVED'
      });
      onConversationChange(res.conversation);
    } catch (err) {
      console.error(err);
    } finally {
      setResolving(false);
    }
  }

  const [changingStage, setChangingStage] = useState(false);
  const currentStage = deriveStage(conversation);

  async function handleStageChange(e: ChangeEvent<HTMLSelectElement>) {
    const stage = e.target.value as CrmStage;
    if (stage === currentStage) return;
    setChangingStage(true);
    const nextTags = tagsForStage(conversation.tags, stage);
    const nextStatus = statusForStage(stage);
    try {
      const res = await apiPatch<{ conversation: Conversation }>(`/api/org/conversations/${conversation.id}`, {
        tags: nextTags,
        ...(nextStatus ? { status: nextStatus } : {})
      });
      onConversationChange(res.conversation);
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
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 14, color: 'var(--text-dim)', cursor: 'pointer' }}
            title="Ocultar panel"
          >
            ✕
          </button>
        )}
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
          ✏️ Editar contacto
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
              <span>📞</span> {formatPhone(conversation.contact.phone)}
              {cleanPhone && (
                <a
                  href={`https://wa.me/${cleanPhone}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ marginLeft: 'auto', fontSize: 11, color: '#25d366', textDecoration: 'none', fontWeight: 700 }}
                >
                  WhatsApp ↗
                </a>
              )}
            </div>
          )}
          {conversation.contact.email && (
            <div className="crm-contact-meta-item">
              <span>✉️</span> {conversation.contact.email}
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
          <span>🔄</span> Transferir conversación
        </button>
        <button
          type="button"
          className="crm-quick-action-btn"
          onClick={onOpenTransfer}
        >
          <span>👤</span> Asignar agente
        </button>
        <button
          type="button"
          className="crm-quick-action-btn"
          onClick={onOpenOrder}
        >
          <span>🛒</span> Crear pedido / cotización
        </button>
        <button
          type="button"
          className="crm-quick-action-btn"
          onClick={handleMarkResolved}
          disabled={resolving || conversation.status === 'RESOLVED'}
        >
          <span>✔️</span> {conversation.status === 'RESOLVED' ? 'Resuelta' : resolving ? 'Marcando...' : 'Marcar como resuelto'}
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
            {note.content}
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
      alert('Error al reenviar el mensaje');
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
                {isSelected && <span style={{ color: 'var(--primary-glow)', fontWeight: 700 }}>✓</span>}
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
        email: email.trim() || null
      });
      onSaved(res.contact);
    } catch (err) {
      console.error(err);
      alert('Error al actualizar el contacto');
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
const PRESENCE_COLOR: Record<AgentPresenceStatus, string> = {
  available: '#10b981',
  busy: '#ef4444',
  away: '#f59e0b',
  offline: '#64748b'
};

const PRESENCE_LABEL: Record<AgentPresenceStatus, string> = {
  available: 'Disponible',
  busy: 'Ocupado',
  away: 'Ausente',
  offline: 'Desconectado'
};

function TransferConversationModal({
  conversation,
  onClose,
  onTransferred
}: {
  conversation: Conversation;
  onClose: () => void;
  onTransferred: (c: Conversation) => void;
}) {
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
      console.error(err);
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
          disabled={submitting}
          style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
        >
          {submitting ? 'Transfiriendo...' : 'Confirmar Transferencia →'}
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
          {submitting ? 'Registrando...' : 'Generar Pedido y Enviar a WhatsApp →'}
        </button>
      </form>
    </Modal>
  );
}

/* =========================================================
   NEW CONVERSATION MODAL
   ========================================================= */
function NewConversationModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Conversation) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ departments: Department[] }>('/api/org/departments')
      .then((data) => setDepartments(data.departments))
      .catch(() => setDepartments([]));
  }, []);

  useEffect(() => {
    if (!query.trim() || selectedContact) {
      setResults([]);
      return;
    }
    const id = setTimeout(() => {
      apiGet<{ contacts: Contact[] }>(`/api/org/contacts?q=${encodeURIComponent(query.trim())}`)
        .then((data) => setResults(data.contacts))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [query, selectedContact]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        subject: subject || undefined,
        departmentId: departmentId || undefined
      };
      if (selectedContact) body.contactId = selectedContact.id;
      else if (creatingNew) body.newContact = { name: newName || undefined, phone: newPhone || undefined, email: newEmail || undefined };

      const data = await apiPost<{ conversation: Conversation }>('/api/org/conversations', body);
      onCreated(data.conversation);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Nueva Conversación" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {!creatingNew && (
          <div className="field">
            <label>Contacto</label>
            {selectedContact ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-surface-2)', padding: '8px 12px', borderRadius: 10 }}>
                <span>{contactLabel(selectedContact)}</span>
                <button type="button" className="btn secondary small" onClick={() => setSelectedContact(null)}>
                  Cambiar
                </button>
              </div>
            ) : (
              <>
                <input
                  className="input"
                  placeholder="Buscar por nombre, teléfono o email…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {results.length > 0 && (
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, marginTop: 6, overflow: 'hidden' }}>
                    {results.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => setSelectedContact(c)}
                        style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border-color)' }}
                      >
                        {contactLabel(c)}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {!selectedContact && (
          <button type="button" className="btn secondary small" onClick={() => setCreatingNew((v) => !v)} style={{ marginBottom: 14 }}>
            {creatingNew ? 'Buscar contacto existente' : '+ Cargar contacto nuevo'}
          </button>
        )}

        {creatingNew && !selectedContact && (
          <>
            <div className="field">
              <label>Nombre</label>
              <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="field">
              <label>Teléfono</label>
              <input className="input" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" className="input" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            </div>
          </>
        )}

        <div className="field">
          <label>Asunto</label>
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>

        <div className="field">
          <label>Departamento</label>
          <select className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Sin asignar</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
          {submitting ? 'Creando…' : 'Crear conversación'}
        </button>
      </form>
    </Modal>
  );
}
