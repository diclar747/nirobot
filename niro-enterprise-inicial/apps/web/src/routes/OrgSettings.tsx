import { FormEvent, useEffect, useState } from 'react';
import { apiGet, apiPatch, ApiError } from '../lib/api';
import type { OwnOrganization } from '../types';
import { useAuth } from '../context/AuthContext';
import { LoadingRows, PageHeader, PageShell, Panel, StatCard, StatGrid } from '../components/PageKit';
import { IconBuilding, IconSettings, IconUsers } from '../components/icons';
import { SyncSettings } from '../components/SyncSettings';

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
    <PageHeader tone="slate" hero={{ eyebrow: 'Configuración', title: 'Tu empresa, a tu manera.', text: 'Perfil de la empresa, asistente IA, sincronización con WhatsApp y widget para tu sitio web.', features: [{ icon: 'building', label: 'Perfil' }, { icon: 'sparkles', label: 'Asistente IA' }, { icon: 'globe', label: 'Widget web' }], art: ['settings', 'building', 'globe'] }}
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
      <TranscriptionCard org={org} onSaved={(settings) => { setOrg({ ...org, settings }); setSuccess('Ajustes actualizados'); }} onError={setError} />
      <SyncSettings />
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

function TranscriptionCard({ org, onSaved, onError }: { org: OwnOrganization; onSaved: (settings: OwnOrganization['settings']) => void; onError: (msg: string | null) => void }) {
  const enabled = Boolean(org.settings?.autoTranscribeAudio);
  const configured = org.settings?.niroAiConfigured !== false;
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    onError(null);
    setSaving(true);
    try {
      const data = await apiPatch<{ settings: OwnOrganization['settings'] }>('/api/org/settings', { autoTranscribeAudio: next });
      onSaved(data.settings);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'No se pudo guardar la configuración');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Transcripción de audios</h3>
      <p className="muted" style={{ marginTop: -8, marginBottom: 14, fontSize: 13, lineHeight: 1.5 }}>
        Cuando un cliente te manda un audio, el sistema lo transcribe con Niro IA y muestra el <b>texto debajo del audio</b> en el chat, así lo leés sin necesidad de escucharlo.
      </p>
      <label className="transcribe-switch">
        <input type="checkbox" role="switch" checked={enabled} disabled={saving || !configured} onChange={(e) => toggle(e.target.checked)} />
        <span className="transcribe-track" />
        <span><b>Transcribir audios automáticamente</b><small>{enabled ? 'Activado: los audios nuevos se transcriben solos.' : 'Desactivado: podés transcribir un audio puntual con el botón “Transcribir” del chat.'}</small></span>
      </label>
      {!configured && <div className="alert error" style={{ marginTop: 12 }}>Falta configurar la API de Niro IA en el servidor, por eso no se puede activar.</div>}
      <p className="muted" style={{ fontSize: 12, margin: '12px 0 0' }}>Cada audio transcripto consume créditos de Niro IA. Los audios anteriores no se transcriben solos.</p>
    </div>
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
