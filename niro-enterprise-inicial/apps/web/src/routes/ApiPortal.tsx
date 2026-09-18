import { useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPost, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { PageHeader, PageShell, Panel, StatCard, StatGrid, Pill } from '../components/PageKit';
import { IconSettings } from '../components/icons';
import '../styles/api-portal.css';

type ApiKeyRecord = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  messageCount: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string; email: string } | null;
};

type Session = { id: string; label: string; phone: string | null; status: string; hasQr: boolean };

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

function formatDate(value: string | null) {
  if (!value) return 'Nunca';
  return new Intl.DateTimeFormat('es-PY', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function copyText(value: string) {
  return navigator.clipboard?.writeText(value);
}

export function ApiPortal() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [name, setName] = useState('Integración principal');
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [testKey, setTestKey] = useState('');
  const [to, setTo] = useState('595981234567');
  const [type, setType] = useState('text');
  const [text, setText] = useState('Hola 👋 Este es un mensaje enviado desde la API de NIRO.');
  const [caption, setCaption] = useState('');
  const [ptt, setPtt] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [keyData, sessionData] = await Promise.all([
        apiGet<{ apiKeys: ApiKeyRecord[] }>('/api/org/api-keys'),
        apiGet<{ sessions: Session[] }>('/api/org/whatsapp/sessions')
      ]);
      setKeys(keyData.apiKeys);
      setSessions(sessionData.sessions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el portal de API');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createKey() {
    setError(null);
    setNotice(null);
    setWorking(true);
    try {
      const data = await apiPost<{ apiKey: ApiKeyRecord; secret: string }>('/api/org/api-keys', { name });
      setKeys((prev) => [data.apiKey, ...prev]);
      setSecret(data.secret);
      setTestKey(data.secret);
      setNotice('API key creada. Copiala ahora: no volverá a mostrarse completa.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear la API key');
    } finally {
      setWorking(false);
    }
  }

  async function revokeKey(key: ApiKeyRecord) {
    if (!window.confirm(`¿Revocar la clave “${key.name}”? Las integraciones que la usen dejarán de funcionar.`)) return;
    setError(null);
    try {
      await apiDelete(`/api/org/api-keys/${key.id}`);
      setKeys((prev) => prev.map((item) => item.id === key.id ? { ...item, revokedAt: new Date().toISOString() } : item));
      setNotice('API key revocada correctamente.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo revocar la API key');
    }
  }

  async function runTest() {
    setError(null);
    setTestOutput(null);
    setTesting(true);
    try {
      const key = testKey.trim() || secret || '';
      if (!key) throw new Error('Pegá o generá una API key para probar el envío');
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
      let body: BodyInit;
      if (file && MEDIA_TYPES.has(type)) {
        const form = new FormData();
        form.append('to', to);
        form.append('type', type);
        form.append('text', text);
        form.append('caption', caption);
        form.append('ptt', String(ptt));
        form.append('file', file);
        body = form;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ to, type: 'text', text });
      }
      const response = await fetch('/api/v1/messages', { method: 'POST', headers, body });
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      setTestOutput(JSON.stringify(payload, null, 2));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setNotice('Mensaje enviado correctamente desde el probador.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo ejecutar la prueba');
    } finally {
      setTesting(false);
    }
  }

  const activeKeys = useMemo(() => keys.filter((key) => !key.revokedAt).length, [keys]);
  const connected = sessions.some((session) => session.status === 'connected');
  const apiBase = `${window.location.origin}/api/v1`;
  const textCurl = `curl -X POST ${apiBase}/messages \\\n+  -H "Authorization: Bearer nr_live_TU_CLAVE" \\\n+  -H "Content-Type: application/json" \\\n+  -d '{"to":"595981234567","type":"text","text":"Hola 👋"}'`;
  const mediaCurl = `curl -X POST ${apiBase}/messages \\\n+  -H "Authorization: Bearer nr_live_TU_CLAVE" \\\n+  -F "to=595981234567" -F "type=image" \\\n+  -F "caption=Imagen desde NIRO" -F "file=@foto.jpg"`;

  return (
    <PageShell>
      <PageHeader
        icon={<IconSettings />}
        title="API & Desarrolladores"
        subtitle="Conectá tus sistemas, generá credenciales y probá envíos de WhatsApp desde un solo lugar."
        actions={<a className="btn secondary" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">↗ OpenAPI JSON</a>}
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <div className="api-portal-hero">
        <div><span className="api-eyebrow">NIRO DEVELOPER PLATFORM</span><h2>Tu operación, conectada.</h2><p>Usá una API key de tu organización para enviar texto, imágenes, videos, audio, documentos y stickers manteniendo toda la trazabilidad en el Inbox.</p></div>
        <div className={`api-connection-badge ${connected ? 'connected' : ''}`}><span>{connected ? '●' : '○'}</span>{connected ? 'WhatsApp conectado' : 'WhatsApp sin conectar'}<small>{user?.organization?.name || 'Tu organización'}</small></div>
      </div>

      <StatGrid>
        <StatCard label="Claves activas" value={activeKeys} hint={`${keys.length} creadas en total`} tone="violet" icon={<span>⌁</span>} />
        <StatCard label="Mensajes API" value={keys.reduce((sum, key) => sum + key.messageCount, 0)} hint="Trazables en conversaciones" tone="success" icon={<span>↗</span>} />
        <StatCard label="Sesiones WhatsApp" value={sessions.length} hint={connected ? 'Lista para enviar' : 'Requiere conectar un QR'} tone={connected ? 'success' : 'warning'} icon={<span>◉</span>} />
      </StatGrid>

      <div className="api-portal-grid">
        <Panel title="Credenciales de integración" actions={<span className="api-panel-hint">Solo se muestra el prefijo después de crearla</span>}>
          <div className="api-create-row"><input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Nombre de la integración" /><button className="btn" type="button" onClick={createKey} disabled={working || !name.trim()}>{working ? 'Generando…' : '+ Generar API key'}</button></div>
          {secret && <div className="api-secret-box"><div><b>Clave nueva</b><p>Guardala en tu gestor de secretos. No la compartas en el navegador ni en repositorios.</p><code>{secret}</code></div><button className="btn secondary small" type="button" onClick={() => { void copyText(secret).then(() => setCopied(true)); }}>{copied ? 'Copiada ✓' : 'Copiar clave'}</button></div>}
          <div className="api-key-list">
            {loading ? <div className="api-muted">Cargando credenciales…</div> : keys.length === 0 ? <div className="api-empty">Todavía no hay claves. Generá la primera para conectar tu sistema.</div> : keys.map((key) => <div className={`api-key-row ${key.revokedAt ? 'revoked' : ''}`} key={key.id}><div className="api-key-icon">⌘</div><div className="api-key-main"><strong>{key.name}</strong><code>{key.keyPrefix}••••••••</code><small>Creada por {key.createdBy?.name || 'usuario'} · {formatDate(key.createdAt)} · {key.messageCount} mensajes</small></div><Pill tone={key.revokedAt ? 'danger' : 'success'} dot>{key.revokedAt ? 'Revocada' : 'Activa'}</Pill>{!key.revokedAt && <button className="api-revoke" type="button" onClick={() => revokeKey(key)}>Revocar</button>}</div>)}
          </div>
        </Panel>

        <Panel title="Sesión de tu organización">
          <div className="api-tenant-card"><div className="api-tenant-icon">◉</div><div><strong>{user?.organization?.name || 'Organización'}</strong><p>El QR y la sesión de Baileys están aislados por empresa. Todos los usuarios autorizados comparten el estado de esta organización, nunca el de otra.</p></div></div>
          {sessions.length === 0 ? <div className="api-muted">No hay una sesión activa. Abrí Integraciones para generar o escanear el QR.</div> : sessions.map((session) => <div className="api-session-row" key={session.id}><span className={`api-session-dot ${session.status}`} /><div><strong>{session.label}</strong><small>{session.phone || 'Sin número vinculado'} · {session.status}</small></div></div>)}
          <p className="api-security-note">🔒 Las claves API solo pueden enviar usando las sesiones de esta organización y quedan registradas en auditoría.</p>
        </Panel>
      </div>

      <Panel title="Probador en tiempo real" actions={<span className="api-panel-hint">La respuesta aparece abajo, incluso si WhatsApp está desconectado</span>}>
        <div className="api-tester-grid">
          <div className="api-tester-form">
            <label className="api-field-label">API key</label><input className="input" type="password" value={testKey} onChange={(event) => setTestKey(event.target.value)} placeholder="nr_live_…" />
            <div className="api-form-two"><div><label className="api-field-label">Teléfono internacional</label><input className="input" value={to} onChange={(event) => setTo(event.target.value)} /></div><div><label className="api-field-label">Tipo de mensaje</label><select className="input" value={type} onChange={(event) => { setType(event.target.value); setFile(null); }}><option value="text">Texto + emojis</option><option value="image">Imagen</option><option value="video">Video</option><option value="audio">Audio</option><option value="document">Archivo / documento</option><option value="sticker">Sticker WebP</option></select></div></div>
            <label className="api-field-label">Mensaje / texto</label><textarea className="input api-tester-textarea" value={text} onChange={(event) => setText(event.target.value)} />
            {type !== 'text' && <><label className="api-field-label">Archivo</label><input className="input api-file" type="file" accept={type === 'image' ? 'image/*' : type === 'video' ? 'video/*' : type === 'audio' ? 'audio/*' : type === 'sticker' ? 'image/webp' : '*/*'} onChange={(event) => setFile(event.target.files?.[0] || null)} />{(type === 'image' || type === 'video') && <><label className="api-field-label">Caption</label><input className="input" value={caption} onChange={(event) => setCaption(event.target.value)} /></>}{type === 'audio' && <label className="api-check"><input type="checkbox" checked={ptt} onChange={(event) => setPtt(event.target.checked)} /> Enviar como nota de voz</label>}</>}
            <button className="btn" type="button" onClick={runTest} disabled={testing || (type !== 'text' && !file)}>{testing ? 'Enviando…' : '▶ Ejecutar envío de prueba'}</button>
          </div>
          <div className="api-response-panel"><div className="api-response-top"><span>Respuesta de la API</span><code>POST /messages</code></div><pre>{testOutput || '{\n  "status": "ready",\n  "message": "La respuesta del envío aparecerá aquí"\n}'}</pre></div>
        </div>
      </Panel>

      <Panel title="Documentación rápida" actions={<a className="api-doc-link" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">Descargar OpenAPI 3.0 ↗</a>}>
        <div className="api-doc-grid"><DocBlock title="Texto, emojis y respuestas" code={textCurl} /><DocBlock title="Imagen, video, audio, archivo o sticker" code={mediaCurl} /></div>
        <div className="api-endpoint-table"><div><b>Método</b><b>Endpoint</b><b>Uso</b></div><div><span className="api-method post">POST</span><code>/api/v1/messages</code><span>Enviar texto o multimedia</span></div><div><span className="api-method get">GET</span><code>/api/v1/sessions</code><span>Consultar las líneas de tu empresa</span></div><div><span className="api-method get">GET</span><code>/api/v1/openapi.json</code><span>Contrato OpenAPI completo</span></div></div>
        <p className="api-doc-note">Autenticación: enviá <code>Authorization: Bearer nr_live_…</code> o <code>X-API-Key</code>. El teléfono debe estar en formato internacional. Los archivos se envían como <code>multipart/form-data</code> y admiten hasta 15 MB.</p>
      </Panel>
    </PageShell>
  );
}

function DocBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="api-code-card"><div><strong>{title}</strong><button type="button" onClick={() => { void copyText(code).then(() => setCopied(true)); }}>{copied ? 'Copiado ✓' : 'Copiar'}</button></div><pre>{code}</pre></div>;
}
