import { DragEvent, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { getSocket } from '../lib/socket';
import { initials } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { PRESENCE_LABEL, PRESENCE_ORDER } from '../lib/presence';
import type { AgentPresence, AgentPresenceStatus, Conversation, OrgUser } from '../types';

/** MIME type used when dragging a conversation onto an agent. */
export const CONVERSATION_DRAG_TYPE = 'application/x-niro-conversation';

export function setConversationDragData(e: DragEvent, conversationId: string) {
  e.dataTransfer.setData(CONVERSATION_DRAG_TYPE, conversationId);
  e.dataTransfer.setData('text/plain', conversationId);
  e.dataTransfer.effectAllowed = 'move';
}

const STATUS_LABEL = PRESENCE_LABEL;
const STATUS_ORDER = PRESENCE_ORDER;

type AgentRow = { id: string; name: string; role: string; status: AgentPresenceStatus };

export function AgentsDropPanel({
  conversation,
  onConversationChange
}: {
  conversation: Conversation;
  onConversationChange: (c: Conversation) => void;
}) {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [presence, setPresence] = useState<AgentPresence[]>([]);
  const [overId, setOverId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    // /users is restricted to OWNER/ADMIN/SUPERVISOR; agents fall back to the presence list.
    apiGet<{ users: OrgUser[] }>('/api/org/users').then((d) => setUsers(d.users)).catch(() => {});
    apiGet<{ presence: AgentPresence[] }>('/api/org/presence').then((d) => setPresence(d.presence)).catch(() => {});

    const socket = getSocket();
    const onPresence = ({ presence: list }: { presence: AgentPresence[] }) => setPresence(list);
    socket.on('agent:presence_list', onPresence);
    return () => {
      socket.off('agent:presence_list', onPresence);
    };
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3500);
    return () => clearTimeout(t);
  }, [feedback]);

  const agents = useMemo<AgentRow[]>(() => {
    const byId = new Map<string, AgentRow>();
    for (const u of users) {
      if (!u.active) continue;
      byId.set(u.id, { id: u.id, name: u.name, role: u.role, status: 'offline' });
    }
    for (const p of presence) {
      const status: AgentPresenceStatus = p.online ? p.status : 'offline';
      const existing = byId.get(p.userId);
      if (existing) existing.status = status;
      else byId.set(p.userId, { id: p.userId, name: p.name, role: p.role, status });
    }
    return [...byId.values()].sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name)
    );
  }, [users, presence]);

  const onlineCount = agents.filter((a) => a.status !== 'offline').length;

  async function transferTo(agent: AgentRow, conversationId: string) {
    setBusyId(agent.id);
    try {
      const res = await apiPost<{ conversation: Conversation }>(`/api/org/conversations/${conversationId}/transfer`, {
        targetUserId: agent.id,
        departmentId: null,
        note: null
      });
      onConversationChange(res.conversation);
      setFeedback({ ok: true, text: `Chat transferido a ${agent.name}` });
    } catch (err) {
      console.error(err);
      setFeedback({ ok: false, text: 'No se pudo transferir el chat' });
    } finally {
      setBusyId(null);
    }
  }

  function handleDragOver(e: DragEvent, agentId: string) {
    if (!e.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overId !== agentId) setOverId(agentId);
  }

  function handleDrop(e: DragEvent, agent: AgentRow) {
    e.preventDefault();
    setOverId(null);
    const conversationId = e.dataTransfer.getData(CONVERSATION_DRAG_TYPE);
    if (!conversationId || busyId) return;
    if (conversationId === conversation.id && conversation.assignedTo?.id === agent.id) {
      setFeedback({ ok: false, text: `${agent.name} ya tiene este chat` });
      return;
    }
    transferTo(agent, conversationId);
  }

  return (
    <div className="crm-quick-actions-box agents-drop-panel">
      <div className="agents-drop-head">
        <div className="crm-section-subtitle" style={{ margin: 0 }}>Agentes</div>
        <span className="agents-drop-count">
          <span className="agents-drop-dot available" /> {onlineCount} en línea
        </span>
      </div>

      <div
        className="agents-drop-chip"
        draggable
        onDragStart={(e) => setConversationDragData(e, conversation.id)}
        title="Arrastrá este chat sobre un agente para transferirlo"
      >
        <span className="agents-drop-grip">⋮⋮</span>
        <span>Arrastrá este chat sobre un agente</span>
      </div>

      {feedback && <div className={`agents-drop-feedback ${feedback.ok ? 'ok' : 'error'}`}>{feedback.text}</div>}

      <div className="agents-drop-list">
        {agents.length === 0 && <div className="agents-drop-empty">No hay agentes para mostrar</div>}
        {agents.map((a) => {
          const isAssigned = conversation.assignedTo?.id === a.id;
          return (
            <div
              key={a.id}
              className={[
                'agents-drop-item',
                overId === a.id ? 'is-over' : '',
                isAssigned ? 'is-assigned' : '',
                a.status === 'offline' ? 'is-offline' : ''
              ].join(' ')}
              onDragOver={(e) => handleDragOver(e, a.id)}
              onDragLeave={() => setOverId((cur) => (cur === a.id ? null : cur))}
              onDrop={(e) => handleDrop(e, a)}
            >
              <div className="agents-drop-avatar">
                {initials(a.name)}
                <span className={`agents-drop-dot ${a.status}`} />
              </div>
              <div className="agents-drop-info">
                <div className="agents-drop-name">{a.name.replace(/\s+\d{6,}\s*$/, '') || a.name}{a.id === me?.id ? ' (vos)' : ''}</div>
                <div className="agents-drop-meta">
                  {busyId === a.id ? 'Transfiriendo...' : isAssigned ? 'Asignado a este chat' : STATUS_LABEL[a.status]}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
