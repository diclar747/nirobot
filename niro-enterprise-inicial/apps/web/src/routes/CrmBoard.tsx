import { useCallback, useEffect, useMemo, useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { contactLabel, formatPhone, formatTime, initials, isUsablePhone, phoneDigits } from '../lib/format';
import { CRM_STAGES, deriveStage, statusForStage, tagsForStage, type CrmStage } from '../lib/crmStage';
import { Modal } from '../components/Modal';
import { PageHeader, Pill } from '../components/PageKit';
import { IconLayers } from '../components/icons';
import type { Conversation, OrgUser, Department, Message } from '../types';
import { Ui } from '../components/Ui';
import { useOutcome } from '../context/OutcomeContext';

export function CrmBoard() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const { patchConversation } = useOutcome();
  const [selectedForDetail, setSelectedForDetail] = useState<Conversation | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const upsertConversation = useCallback((conversation: Conversation) => {
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conversation.id);
      return idx === -1 ? [conversation, ...prev] : prev.map((c) => (c.id === conversation.id ? conversation : c));
    });
    setSelectedForDetail((prev) => (prev?.id === conversation.id ? conversation : prev));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiGet<{ conversations: Conversation[] }>('/api/org/conversations')
      .then((data) => setConversations(data.conversations))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudo cargar el tablero'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const socket = getSocket();
    const onNew = ({ conversation }: { conversation: Conversation }) => upsertConversation(conversation);
    const onUpdated = ({ conversation }: { conversation: Conversation }) => upsertConversation(conversation);
    socket.on('conversation:new', onNew);
    socket.on('conversation:updated', onUpdated);
    return () => {
      socket.off('conversation:new', onNew);
      socket.off('conversation:updated', onUpdated);
    };
  }, [upsertConversation]);

  const columns = useMemo(() => {
    const byStage = new Map<CrmStage, Conversation[]>(CRM_STAGES.map((s) => [s.key, []]));
    for (const c of conversations) {
      byStage.get(deriveStage(c))!.push(c);
    }
    for (const list of byStage.values()) {
      list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    return byStage;
  }, [conversations]);

  const activeConversation = conversations.find((c) => c.id === activeId) || null;

  async function moveToStage(conversation: Conversation, stage: CrmStage) {
    if (deriveStage(conversation) === stage) return;
    setMoving(conversation.id);
    const nextTags = tagsForStage(conversation.tags, stage);
    const nextStatus = statusForStage(stage);
    // Pasar a "Cerradas" pide cómo terminó (venta, perdida, cotización…): la tarjeta no se mueve hasta confirmarlo.
    const closing = Boolean(nextStatus && ['RESOLVED', 'CLOSED'].includes(nextStatus) && !['RESOLVED', 'CLOSED'].includes(conversation.status));
    if (!closing) upsertConversation({ ...conversation, tags: nextTags, status: nextStatus || conversation.status });
    try {
      const res = await patchConversation(conversation, { tags: nextTags, ...(nextStatus ? { status: nextStatus } : {}) });
      if (res) upsertConversation(res.conversation);
    } catch (err) {
      console.error(err);
      if (!closing) upsertConversation(conversation);
    } finally {
      setMoving(null);
    }
  }

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const conversation = conversations.find((c) => c.id === active.id);
    const stage = CRM_STAGES.find((s) => s.key === over.id)?.key;
    if (!conversation || !stage) return;
    moveToStage(conversation, stage);
  }

  return (
    <div className="crm-board-wrap">
      <div className="crm-board-header">
        <PageHeader tone="violet" hero={{ eyebrow: 'Embudo de ventas', title: 'Llevá cada oportunidad hasta el cierre.', compact: true }}
          icon={<IconLayers />}
          title="Embudo de ventas (CRM)"
          subtitle="Arrastrá las tarjetas para cambiar la etapa del cliente. Hacé clic en un contacto para ver notas y detalles."
          actions={!loading && <Pill tone="primary">{conversations.length} oportunidades</Pill>}
        />
      </div>

      {loading && <p style={{ padding: 16, color: 'var(--text-dim)' }}>Cargando tablero...</p>}
      {!loading && error && <p style={{ padding: 16, color: 'var(--danger)' }}>{error}</p>}

      {!loading && !error && (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="crm-board-columns">
            {CRM_STAGES.map((stage) => (
              <BoardColumn
                key={stage.key}
                stageKey={stage.key}
                label={stage.label}
                color={stage.color}
                conversations={columns.get(stage.key) || []}
                movingId={moving}
                onSelectConversation={setSelectedForDetail}
              />
            ))}
          </div>

          <DragOverlay>
            {activeConversation && <BoardCard conversation={activeConversation} dragging />}
          </DragOverlay>
        </DndContext>
      )}

      {/* Contact Details & Notes Modal */}
      {selectedForDetail && (
        <ContactDetailModal
          conversation={selectedForDetail}
          onClose={() => setSelectedForDetail(null)}
          onConversationChange={upsertConversation}
          onOpenChat={() => {
            navigate('/inbox');
          }}
        />
      )}
    </div>
  );
}

function BoardColumn({
  stageKey,
  label,
  color,
  conversations,
  movingId,
  onSelectConversation
}: {
  stageKey: CrmStage;
  label: string;
  color: string;
  conversations: Conversation[];
  movingId: string | null;
  onSelectConversation?: (c: Conversation) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stageKey });

  return (
    <div className={`crm-board-column ${isOver ? 'drag-over' : ''}`} ref={setNodeRef}>
      <div className="crm-board-column-header">
        <span className="crm-board-column-dot" style={{ background: color }} />
        <span>{label}</span>
        <span className="crm-board-column-count">{conversations.length}</span>
      </div>
      <div className="crm-board-column-body">
        {conversations.length === 0 && <p className="crm-board-empty">Sin conversaciones</p>}
        {conversations.map((c) => (
          <BoardCard
            key={c.id}
            conversation={c}
            moving={movingId === c.id}
            onClick={() => onSelectConversation?.(c)}
          />
        ))}
      </div>
    </div>
  );
}

function BoardCard({
  conversation,
  dragging,
  moving,
  onClick
}: {
  conversation: Conversation;
  dragging?: boolean;
  moving?: boolean;
  onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: conversation.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  const extraTags = conversation.tags.filter((t) => !CRM_STAGES.some((s) => s.tag === t));
  const contact = conversation.contact;
  const label = contactLabel(contact);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={() => {
        // Prevent click if we were dragging
        if (!transform) {
          onClick?.();
        }
      }}
      className={`crm-board-card ${dragging ? 'dragging' : ''} ${moving ? 'moving' : ''}`}
    >
      <div className="crm-board-card-top">
        <div
          className="crm-conv-avatar"
          style={{
            width: 32,
            height: 32,
            fontSize: 12,
            borderRadius: '50%',
            overflow: 'hidden',
            flexShrink: 0
          }}
        >
          {contact.avatarUrl ? (
            <img src={contact.avatarUrl} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            initials(label)
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="crm-board-card-name" style={{ fontWeight: 700, fontSize: 13 }}>
            {label}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 1 }}>
            {contact.phone ? (
              <span style={{ fontSize: 11, color: 'var(--primary-glow)', fontWeight: 600 }}>
                <Ui name="phone" size={14} /> {formatPhone(contact.phone)}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Sin teléfono</span>
            )}
            <span className="crm-board-card-time">{formatTime(conversation.updatedAt)}</span>
          </div>
        </div>
      </div>

      <div className="crm-board-card-subject" style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
        {conversation.subject || 'Sin asunto'}
      </div>

      {(extraTags.length > 0 || conversation.assignedTo || conversation.department) && (
        <div className="crm-board-card-tags" style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {conversation.assignedTo && (
            <span className="crm-board-card-chip agent" style={{ fontSize: 10.5, padding: '2px 6px' }}>
              <Ui name="user" size={14} /> {conversation.assignedTo.name}
            </span>
          )}
          {conversation.department && (
            <span className="crm-board-card-chip" style={{ fontSize: 10.5, padding: '2px 6px', background: 'var(--bg-surface-2)' }}>
              <Ui name="building" size={14} /> {conversation.department.name}
            </span>
          )}
          {extraTags.map((t) => (
            <span key={t} className="crm-board-card-chip" style={{ fontSize: 10.5, padding: '2px 6px' }}>
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* =========================================================
   CONTACT DETAIL & NOTES MODAL
   ========================================================= */
function ContactDetailModal({
  conversation,
  onClose,
  onConversationChange,
  onOpenChat
}: {
  conversation: Conversation;
  onClose: () => void;
  onConversationChange: (c: Conversation) => void;
  onOpenChat: () => void;
}) {
  const [agents, setAgents] = useState<OrgUser[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [notes, setNotes] = useState<Message[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [updating, setUpdating] = useState(false);
  const { patchConversation } = useOutcome();

  const contact = conversation.contact;
  const currentStage = deriveStage(conversation);

  useEffect(() => {
    apiGet<{ users: OrgUser[] }>('/api/org/users').then((d) => setAgents(d.users)).catch(() => {});
    apiGet<{ departments: Department[] }>('/api/org/departments').then((d) => setDepartments(d.departments)).catch(() => {});
    apiGet<{ messages: Message[] }>(`/api/org/conversations/${conversation.id}/messages`)
      .then((d) => {
        setNotes(d.messages.filter((m) => m.direction === 'NOTE'));
      })
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
    } catch (err) {
      console.error(err);
    } finally {
      setSavingNote(false);
    }
  }

  async function handleStageChange(stage: CrmStage) {
    setUpdating(true);
    const nextTags = tagsForStage(conversation.tags, stage);
    const nextStatus = statusForStage(stage);
    try {
      const res = await patchConversation(conversation, { tags: nextTags, ...(nextStatus ? { status: nextStatus } : {}) });
      if (res) onConversationChange(res.conversation);
    } catch (err) {
      console.error(err);
    } finally {
      setUpdating(false);
    }
  }

  async function handleAssignAgent(agentId: string) {
    setUpdating(true);
    try {
      const res = await apiPatch<{ conversation: Conversation }>(`/api/org/conversations/${conversation.id}`, {
        assignedToId: agentId || null
      });
      onConversationChange(res.conversation);
    } catch (err) {
      console.error(err);
    } finally {
      setUpdating(false);
    }
  }

  async function handleAssignDept(deptId: string) {
    setUpdating(true);
    try {
      const res = await apiPatch<{ conversation: Conversation }>(`/api/org/conversations/${conversation.id}`, {
        departmentId: deptId || null
      });
      onConversationChange(res.conversation);
    } catch (err) {
      console.error(err);
    } finally {
      setUpdating(false);
    }
  }

  const cleanPhone = isUsablePhone(contact.phone) ? phoneDigits(contact.phone) : null;

  return (
    <Modal title={`Ficha de Contacto: ${contactLabel(contact)}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Contact Info Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: 14,
            background: 'var(--bg-surface-2)',
            borderRadius: 12,
            border: '1px solid var(--border-color)'
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--primary) 0%, var(--accent) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 20,
              fontWeight: 800,
              flexShrink: 0
            }}
          >
            {contact.avatarUrl ? (
              <img
                src={contact.avatarUrl}
                alt={contactLabel(contact)}
                style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
              />
            ) : (
              initials(contactLabel(contact))
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-main)' }}>
              {contactLabel(contact)}
            </div>
            {contact.phone && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                <span style={{ fontSize: 13, color: 'var(--primary-glow)', fontWeight: 600 }}>
                  <Ui name="phone" size={14} /> {formatPhone(contact.phone)}
                </span>
                {cleanPhone && (
                  <a
                    href={`https://wa.me/${cleanPhone}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      fontSize: 11,
                      background: 'rgba(37, 211, 102, 0.15)',
                      color: '#25d366',
                      padding: '2px 8px',
                      borderRadius: 10,
                      textDecoration: 'none',
                      fontWeight: 700
                    }}
                  >
                    Abrir en WhatsApp <Ui name="external" size={14} />
                  </a>
                )}
              </div>
            )}
            {contact.email && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
                <Ui name="mail" size={14} /> {contact.email}
              </div>
            )}
          </div>
        </div>

        {/* Action Controls (Stage, Agent, Dept) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
          <div className="field">
            <label style={{ fontSize: 12 }}>Etapa CRM</label>
            <select
              className="input"
              value={currentStage}
              disabled={updating}
              onChange={(e) => handleStageChange(e.target.value as CrmStage)}
            >
              {CRM_STAGES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label style={{ fontSize: 12 }}>Agente Asignado</label>
            <select
              className="input"
              value={conversation.assignedTo?.id || ''}
              disabled={updating}
              onChange={(e) => handleAssignAgent(e.target.value)}
            >
              <option value="">Sin asignar</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.role})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label style={{ fontSize: 12 }}>Departamento</label>
          <select
            className="input"
            value={conversation.department?.id || ''}
            disabled={updating}
            onChange={(e) => handleAssignDept(e.target.value)}
          >
            <option value="">Sin departamento</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        {/* Internal Notes Section */}
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-main)', marginBottom: 8 }}>
            <Ui name="note" size={16} /> Notas Internas del Cliente ({notes.length})
          </div>

          <div
            style={{
              maxHeight: 140,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              marginBottom: 10
            }}
          >
            {notes.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                No hay notas registradas para este contacto.
              </div>
            ) : (
              notes.map((n) => (
                <div
                  key={n.id}
                  style={{
                    fontSize: 12,
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'var(--bg-surface-2)',
                    border: '1px solid var(--border-subtle)'
                  }}
                >
                  <div style={{ color: 'var(--text-main)' }}>{n.content}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
                    {n.sender?.name || 'Agente'} · {formatTime(n.createdAt)}
                  </div>
                </div>
              ))
            )}
          </div>

          <form onSubmit={handleAddNote} style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              style={{ flex: 1, fontSize: 12.5 }}
              placeholder="Escribe una nota interna..."
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
            <button type="submit" className="btn small" disabled={savingNote || !newNote.trim()}>
              {savingNote ? 'Guardando...' : 'Guardar Nota'}
            </button>
          </form>
        </div>

        {/* Direct Action Button */}
        <div style={{ display: 'flex', gap: 10, marginTop: 6, borderTop: '1px solid var(--border-color)', paddingTop: 14 }}>
          <button
            type="button"
            className="btn"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => {
              onClose();
              onOpenChat();
            }}
          >
            <Ui name="chat" size={16} /> Abrir Conversación en Chat <Ui name="arrow-right" size={14} />
          </button>
          <button type="button" className="btn secondary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </Modal>
  );
}
