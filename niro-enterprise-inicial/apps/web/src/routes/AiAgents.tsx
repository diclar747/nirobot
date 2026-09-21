import { FormEvent, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Modal } from '../components/Modal';
import { EmptyState, LoadingRows, PageHeader, PageShell, Panel, Pill, StatCard, StatGrid } from '../components/PageKit';
import type { AiAgent, AiAgentCategory, AiChatTurn, AiStatus, AiUsageSummary } from '../types';
import { Ui } from '../components/Ui';

const CATEGORY_LABEL: Record<AiAgentCategory, string> = {
  CHAT: 'Chat general',
  CODING: 'Programación',
  RESEARCH: 'Investigación'
};

function AgentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="9" width="18" height="11" rx="2" />
      <circle cx="8.5" cy="14.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="14.5" r="1.4" fill="currentColor" stroke="none" />
      <path d="M12 9V5" />
      <circle cx="12" cy="3.5" r="1.5" />
    </svg>
  );
}

export function AiAgents() {
  const { user } = useAuth();
  const canManage = user ? ['OWNER', 'ADMIN', 'SUPERVISOR'].includes(user.role) : false;

  const [status, setStatus] = useState<AiStatus | null>(null);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [chatAgent, setChatAgent] = useState<AiAgent | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, agentsRes] = await Promise.all([
        apiGet<AiStatus>('/api/org/ai/status'),
        apiGet<{ agents: AiAgent[] }>('/api/org/ai/agents')
      ]);
      setStatus(statusRes);
      setAgents(agentsRes.agents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los agentes de IA');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <PageShell>
      <PageHeader
        icon={<AgentIcon />}
        title="Agentes IA"
        subtitle="Agentes con su propio prompt, potenciados por la API de Niro IA. Se usan para tareas puntuales o para probar respuestas antes de llevarlas al bot de WhatsApp."
        actions={
          canManage && (
            <button className="btn" onClick={() => setShowCreate(true)}>
              + Nuevo agente
            </button>
          )
        }
      />

      {error && <div className="alert error">{error}</div>}

      {status && !status.configured && (
        <div className="alert error">
          Falta configurar la API key de Niro IA en el servidor (<code>NIRO_AI_API_KEY</code>). Los agentes no van a poder
          responder hasta que se configure.
        </div>
      )}

      <StatGrid>
        <StatCard
          label="Estado de la API"
          value={status ? (status.configured ? 'Conectada' : 'Sin configurar') : '—'}
          hint="niro.cnid.com.py"
          tone={status?.configured ? 'success' : 'danger'}
          icon={<AgentIcon />}
        />
        <StatCard
          label="Bot de WhatsApp"
          value={status ? (status.aiEnabled ? 'Activado' : 'Apagado') : '—'}
          hint="Se activa desde Configuración"
          tone={status?.aiEnabled ? 'success' : 'neutral'}
          icon={<AgentIcon />}
        />
        <StatCard label="Agentes propios" value={loading ? '—' : agents.length} hint="Creados en esta organización" tone="violet" icon={<AgentIcon />} />
      </StatGrid>

      <UsagePanel />

      <Panel flush title="Tus agentes">
        {loading ? (
          <LoadingRows rows={3} />
        ) : agents.length === 0 ? (
          <EmptyState
            icon={<AgentIcon />}
            title="Todavía no creaste ningún agente"
            text="Un agente tiene su propio prompt (personalidad + instrucciones) y podés conversar con él para probarlo."
            action={
              canManage && (
                <button className="btn" onClick={() => setShowCreate(true)}>
                  + Crear el primero
                </button>
              )
            }
          />
        ) : (
          <div className="page-card-grid" style={{ padding: 16 }}>
            {agents.map((a) => (
              <div className="page-card" key={a.id}>
                <div className="row between" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <h3 className="page-card-title">{a.name}</h3>
                    <p className="page-card-text">{a.description || 'Sin descripción'}</p>
                  </div>
                  <Pill tone="primary">{CATEGORY_LABEL[a.category] || a.category}</Pill>
                </div>
                <div className="page-card-footer">
                  <button className="btn secondary small" style={{ marginLeft: 'auto' }} onClick={() => setChatAgent(a)}>
                    <Ui name="chat" size={14} /> Probar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {showCreate && (
        <CreateAgentModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {chatAgent && <AgentChatModal agent={chatAgent} onClose={() => setChatAgent(null)} />}
    </PageShell>
  );
}

function UsagePanel() {
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    apiGet<AiUsageSummary>(`/api/org/ai/usage/summary?days=${days}`)
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <Panel
      flush
      title="Uso de IA"
      actions={
        <select className="input" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Últimos 7 días</option>
          <option value={30}>Últimos 30 días</option>
          <option value={90}>Últimos 90 días</option>
        </select>
      }
    >
      {loading ? (
        <LoadingRows rows={2} />
      ) : !summary || summary.totalCalls === 0 ? (
        <EmptyState icon={<AgentIcon />} title="Todavía no hay uso registrado" text="Cada llamada a la IA (bot, agentes, transcripción, OCR) va a aparecer acá." />
      ) : (
        <div style={{ padding: 16 }}>
          <p className="page-muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
            {summary.totalCalls} llamadas en los últimos {summary.days} días. El costo se muestra tal cual lo devuelve la
            API de Niro IA, desglosado por tipo — no se suma entre tipos porque la unidad no es necesariamente la misma
            en cada uno. Para el detalle en tu moneda, consultá <code>/wallet</code> en la plataforma de Niro IA.
          </p>
          <div className="page-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th className="num">Llamadas</th>
                  <th className="num">Costo (Niro IA)</th>
                </tr>
              </thead>
              <tbody>
                {summary.byKind.map((k) => (
                  <tr key={k.kind}>
                    <td>{k.label}</td>
                    <td className="num">{k.calls}</td>
                    <td className="num">{k.cost === null ? '—' : k.cost.toLocaleString('es-PY', { maximumFractionDigits: 4 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}

function CreateAgentModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<AiAgentCategory>('CHAT');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiPost('/api/org/ai/agents', { name, description: description || undefined, category, systemPrompt });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear el agente');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Nuevo agente IA" onClose={onClose}>
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="agent-name">Nombre</label>
          <input id="agent-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Asesor Legal" />
        </div>
        <div className="field">
          <label htmlFor="agent-desc">Descripción (opcional)</label>
          <input
            id="agent-desc"
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Responde consultas legales básicas"
          />
        </div>
        <div className="field">
          <label htmlFor="agent-category">Categoría</label>
          <select id="agent-category" className="input" value={category} onChange={(e) => setCategory(e.target.value as AiAgentCategory)}>
            <option value="CHAT">Chat general</option>
            <option value="CODING">Programación</option>
            <option value="RESEARCH">Investigación</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="agent-prompt">Instrucciones (system prompt)</label>
          <textarea
            id="agent-prompt"
            className="input"
            rows={5}
            required
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Sos un asesor legal experto en derecho paraguayo. Respondé de forma clara y citá la normativa relevante."
          />
        </div>
        <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
          {submitting ? 'Creando…' : 'Crear agente'}
        </button>
      </form>
    </Modal>
  );
}

function AgentChatModal({ agent, onClose }: { agent: AiAgent; onClose: () => void }) {
  const [turns, setTurns] = useState<AiChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    const nextTurns = [...turns, { role: 'user' as const, content: text }];
    setTurns(nextTurns);
    setInput('');
    setSending(true);
    try {
      const res = await apiPost<{ reply: string }>(`/api/org/ai/agents/${agent.id}/chat`, { messages: nextTurns });
      setTurns((prev) => [...prev, { role: 'assistant', content: res.reply || '(sin respuesta)' }]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'El agente no pudo responder');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title={`Probar: ${agent.name}`} onClose={onClose}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          maxHeight: 320,
          minHeight: 120,
          overflowY: 'auto',
          padding: '4px 2px',
          marginBottom: 12
        }}
      >
        {turns.length === 0 && <p className="page-muted" style={{ fontSize: 13 }}>Escribí algo para probar cómo responde este agente.</p>}
        {turns.map((t, i) => (
          <div
            key={i}
            style={{
              alignSelf: t.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              padding: '8px 12px',
              borderRadius: 12,
              fontSize: 13,
              lineHeight: 1.4,
              background: t.role === 'user' ? 'var(--primary-soft)' : 'var(--bg-surface-2)',
              color: 'var(--text-main)',
              whiteSpace: 'pre-wrap'
            }}
          >
            {t.content}
          </div>
        ))}
        {sending && <div className="page-muted" style={{ fontSize: 12 }}>Pensando…</div>}
        <div ref={bottomRef} />
      </div>

      {error && <div className="alert error">{error}</div>}

      <form onSubmit={send} style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Escribí un mensaje…"
          disabled={sending}
        />
        <button className="btn" type="submit" disabled={sending || !input.trim()}>
          Enviar
        </button>
      </form>
    </Modal>
  );
}
