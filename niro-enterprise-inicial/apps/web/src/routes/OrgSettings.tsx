import { FormEvent, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import type { Department, MenuOption, OwnOrganization } from '../types';
import { useAuth } from '../context/AuthContext';
import { LoadingRows, PageHeader, PageShell, Panel, StatCard, StatGrid } from '../components/PageKit';
import { IconBuilding, IconSettings, IconUsers } from '../components/icons';

export function OrgSettings() {
  const { user: me } = useAuth();
  const [org, setOrg] = useState<OwnOrganization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const isOwner = me?.role === 'OWNER';

  async function load() {
    setLoading(true);
    try {
      const data = await apiGet<{ organization: OwnOrganization }>('/api/org');
      setOrg(data.organization);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar la organización');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const header = (
    <PageHeader
      icon={<IconSettings />}
      title="Ajustes de la organización"
      subtitle="Perfil de la empresa, asistente IA y widget para tu sitio web."
    />
  );

  if (loading) {
    return (
      <PageShell narrow>
        {header}
        <Panel flush>
          <LoadingRows rows={3} />
        </Panel>
      </PageShell>
    );
  }
  if (!org) {
    return (
      <PageShell narrow>
        {header}
        <div className="alert error">{error || 'No se pudo cargar la organización'}</div>
      </PageShell>
    );
  }

  const usagePct = org.maxUsers ? Math.round(((org.userCount ?? 0) / org.maxUsers) * 100) : 0;

  return (
    <PageShell narrow>
      {header}
      {error && <div className="alert error">{error}</div>}
      {success && <div className="alert success">{success}</div>}

      <StatGrid>
        <StatCard label="Plan" value={org.planTier} hint="Suscripción actual" tone="violet" icon={<IconBuilding />} />
        <StatCard
          label="Usuarios"
          value={`${org.userCount ?? 0} / ${org.maxUsers}`}
          hint={`${usagePct}% del cupo utilizado`}
          tone={usagePct >= 90 ? 'danger' : usagePct >= 70 ? 'warning' : 'success'}
          icon={<IconUsers />}
        />
      </StatGrid>

      <ProfileCard org={org} isOwner={isOwner} onSaved={(name) => { setOrg({ ...org, name }); setSuccess('Perfil actualizado'); }} onError={setError} />
      <AiSettingsCard org={org} onSaved={(settings) => { setOrg({ ...org, settings }); setSuccess('Ajustes actualizados'); }} onError={setError} />
      <AiTestCard aiEnabled={!!org.settings?.aiEnabled} />
      <WidgetEmbedCard slug={org.slug} />
    </PageShell>
  );
}

function ProfileCard({
  org,
  isOwner,
  onSaved,
  onError
}: {
  org: OwnOrganization;
  isOwner: boolean;
  onSaved: (name: string) => void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState(org.name);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onError(null);
    setSubmitting(true);
    try {
      await apiPatch('/api/org', { name });
      onSaved(name);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'No se pudo guardar el perfil');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h3 style={{ marginTop: 0 }}>Perfil</h3>
      <div className="field">
        <label htmlFor="org-name">Nombre</label>
        <input
          id="org-name"
          className="input"
          required
          disabled={!isOwner}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Slug</label>
        <input className="input" value={org.slug} disabled />
      </div>
      {isOwner ? (
        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? 'Guardando…' : 'Guardar perfil'}
        </button>
      ) : (
        <p className="muted" style={{ fontSize: 12 }}>
          Solo el propietario puede editar el perfil.
        </p>
      )}
    </form>
  );
}

function AiSettingsCard({
  org,
  onSaved,
  onError
}: {
  org: OwnOrganization;
  onSaved: (settings: OwnOrganization['settings']) => void;
  onError: (msg: string | null) => void;
}) {
  const [welcomeMessage, setWelcomeMessage] = useState(org.settings?.welcomeMessage || '');
  const [systemPrompt, setSystemPrompt] = useState(org.settings?.systemPrompt || '');
  const [aiEnabled, setAiEnabled] = useState(org.settings?.aiEnabled || false);
  const [menuOptions, setMenuOptions] = useState<MenuOption[]>(org.settings?.menuOptions || []);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ departments: Department[] }>('/api/org/departments')
      .then((data) => setDepartments(data.departments))
      .catch(() => setDepartments([]));
  }, []);

  function addMenuOption() {
    if (departments.length === 0) return;
    setMenuOptions((prev) => [...prev, { key: String(prev.length + 1), label: departments[0].name, departmentId: departments[0].id }]);
  }

  function updateMenuOption(index: number, patch: Partial<MenuOption>) {
    setMenuOptions((prev) => prev.map((opt, i) => (i === index ? { ...opt, ...patch } : opt)));
  }

  function removeMenuOption(index: number) {
    setMenuOptions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onError(null);
    setSubmitting(true);
    try {
      const data = await apiPatch<{ settings: OwnOrganization['settings'] }>('/api/org/settings', {
        welcomeMessage,
        systemPrompt,
        aiEnabled,
        menuOptions
      });
      onSaved(data.settings);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'No se pudo guardar la configuración');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h3 style={{ marginTop: 0 }}>Asistente de IA</h3>
      <p className="muted" style={{ marginTop: -8, marginBottom: 16, fontSize: 13 }}>
        Cuando está activado, NIRO manda la bienvenida, deriva por el menú (si configurás opciones) y después
        sigue respondiendo con IA hasta que un agente humano toma la conversación. Usa la API de Niro IA
        (transcribe audios y hace OCR de imágenes automáticamente en WhatsApp).
      </p>
      <div className="field">
        <label htmlFor="welcome">Mensaje de bienvenida</label>
        <input id="welcome" className="input" value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="prompt">Personalidad e instrucciones del asistente</label>
        <textarea
          id="prompt"
          className="input"
          rows={5}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Ej: Sos el asistente de Ferretería El Sol. Respondé con precios en guaraníes cuando los tengas y ofrecé hablar con un agente para pedidos grandes."
        />
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Si lo dejás vacío, se usa una personalidad genérica de atención al cliente.
        </p>
      </div>
      <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input id="ai-enabled" type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} />
        <label htmlFor="ai-enabled" style={{ textTransform: 'none', fontSize: 14 }}>
          Asistente de IA habilitado (bienvenida, menú y respuestas automáticas)
        </label>
      </div>

      {aiEnabled && (
        <div className="field">
          <label>Opciones del menú (se envían junto al mensaje de bienvenida)</label>
          <div style={{ display: 'grid', gap: 8 }}>
            {menuOptions.map((opt, i) => (
              <div className="row" key={i}>
                <input
                  className="input"
                  style={{ width: 56 }}
                  value={opt.key}
                  onChange={(e) => updateMenuOption(i, { key: e.target.value })}
                  placeholder="1"
                />
                <input
                  className="input"
                  style={{ flex: 1 }}
                  value={opt.label}
                  onChange={(e) => updateMenuOption(i, { label: e.target.value })}
                  placeholder="Ventas"
                />
                <select
                  className="input"
                  style={{ flex: 1 }}
                  value={opt.departmentId}
                  onChange={(e) => updateMenuOption(i, { departmentId: e.target.value })}
                >
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn danger small" onClick={() => removeMenuOption(i)}>
                  Quitar
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn secondary small"
            style={{ marginTop: 8 }}
            onClick={addMenuOption}
            disabled={departments.length === 0}
          >
            + Agregar opción
          </button>
          {departments.length === 0 && (
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Creá al menos un departamento para poder armar el menú.
            </p>
          )}
        </div>
      )}

      <button className="btn" type="submit" disabled={submitting}>
        {submitting ? 'Guardando…' : 'Guardar ajustes'}
      </button>
    </form>
  );
}

function WidgetEmbedCard({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const snippet = `<script src="${window.location.origin}/widget.js" data-org="${slug}" async><\/script>`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard access can be blocked by the browser; the snippet is still selectable by hand
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Widget de chat para tu sitio</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
        Pegá esta línea antes de <code>&lt;/body&gt;</code> en tu sitio web para mostrar el chat de {slug}.
      </p>
      <pre
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '10px 12px',
          fontSize: 12,
          overflowX: 'auto',
          margin: 0
        }}
      >
        {snippet}
      </pre>
      <button className="btn secondary small" style={{ marginTop: 10 }} onClick={copy} type="button">
        {copied ? 'Copiado ✓' : 'Copiar código'}
      </button>
    </div>
  );
}

function AiTestCard({ aiEnabled }: { aiEnabled: boolean }) {
  const [status, setStatus] = useState<{ configured: boolean } | null>(null);
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    apiGet<{ configured: boolean }>('/api/org/ai/status')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text) return;
    setError(null);
    setReply(null);
    setSending(true);
    try {
      const res = await apiPost<{ reply: string; cost: number | null }>('/api/org/ai/chat/test', { message: text });
      setReply(res.reply);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo probar el asistente');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Probar el asistente</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: -6, marginBottom: 12 }}>
        Mandá un mensaje de prueba y mirá cómo respondería el asistente ahora mismo, con el prompt guardado
        arriba. No queda registrado en ninguna conversación real.
      </p>

      {status && !status.configured && (
        <div className="alert error" style={{ marginBottom: 12 }}>
          Falta configurar <code>NIRO_AI_API_KEY</code> en el servidor. El asistente no puede responder todavía.
        </div>
      )}
      {status?.configured && !aiEnabled && (
        <div className="alert" style={{ marginBottom: 12, background: 'var(--warning)', color: '#fff' }}>
          El asistente está apagado (el interruptor de arriba). Podés probarlo igual acá, pero no va a responder
          en WhatsApp ni en el widget hasta que lo actives.
        </div>
      )}

      <form onSubmit={handleSubmit} className="row" style={{ gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Ej: hola, ¿tienen envío a domicilio?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={!status?.configured}
        />
        <button className="btn" type="submit" disabled={sending || !message.trim() || !status?.configured}>
          {sending ? 'Enviando…' : 'Probar'}
        </button>
      </form>

      {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
      {reply && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            borderRadius: 10,
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            fontSize: 13.5,
            whiteSpace: 'pre-wrap'
          }}
        >
          {reply}
        </div>
      )}
    </div>
  );
}
