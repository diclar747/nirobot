import { FormEvent, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Modal } from './Modal';
import { Ui } from './Ui';
import { CRM_STAGES as CRM_STAGE_DEFS, type CrmStage } from '../lib/crmStage';
import { ContactAvatar } from '../routes/Contacts';
import type { CallAccount, CallAudio, CallCampaign } from '../types';

interface AudContact {
  id: string; name: string | null; phone: string | null; email: string | null; avatarUrl: string | null;
  tags: string[]; crmTags: string[]; callConsentStatus: string | null; callOptedOutAt: string | null;
}

const STEPS = [
  { label: 'Datos y audio', short: 'Datos', description: 'Nombrá la campaña, elegí la línea de WhatsApp y el audio que se va a reproducir.' },
  { label: 'Destinatarios', short: 'Contactos', description: 'Elegí a quién llamar: por etapa del CRM, etiqueta o contacto por contacto.' },
  { label: 'Programación y reglas', short: 'Reglas', description: 'Cuándo llamar, cada cuánto, cuántos intentos y si querés una encuesta posterior.' },
  { label: 'Revisión', short: 'Revisar', description: 'Verificá todo antes de guardar la campaña.' }
];

export const CALL_CAMPAIGN_TYPES = [
  { key: 'COMMERCIAL', label: 'Comercial' }, { key: 'NOTIFICATION', label: 'Aviso / notificación' }, { key: 'FOLLOW_UP', label: 'Seguimiento' },
  { key: 'SURVEY', label: 'Encuesta' }, { key: 'INSTITUTIONAL', label: 'Institucional' }
];

type SurveyAction = 'NONE' | 'INTERESTED' | 'FOLLOW_UP' | 'OPT_OUT';
interface SurveyOption { key: string; label: string; action: SurveyAction; replyMessage: string; crmStage?: CrmStage | '' }

// Datos de una campaña existente para precargar el asistente (editar, relanzar o rellamar a un contacto).
export interface WizardSource {
  campaign: CallCampaign;
  survey: { question: string; options: SurveyOption[] } | null;
  recipients: { contactId: string; status: string }[];
  onlyContactIds?: string[];
}
export type WizardMode = 'create' | 'edit' | 'relaunch';
// Resultados que cuentan como "atendió": el resto (no contestó, falló, canceló, pendiente) es candidato a rellamada.
const ANSWERED = new Set(['COMPLETED']);
const ACTIONS: { key: SurveyAction; label: string }[] = [
  { key: 'NONE', label: 'Solo responder' },
  { key: 'INTERESTED', label: 'Marcar como interesado (CRM)' },
  { key: 'FOLLOW_UP', label: 'Contactar más adelante (etiqueta)' },
  { key: 'OPT_OUT', label: 'No volver a llamar' }
];
const DEFAULT_OPTIONS: SurveyOption[] = [
  { key: '1', label: 'Sí, deseo información', action: 'INTERESTED', replyMessage: '¡Muchas gracias por tu interés! 🙌 Te vamos a mantener informado con más detalles muy pronto.' },
  { key: '2', label: 'No, gracias', action: 'OPT_OUT', replyMessage: 'Gracias por tu respuesta. Entendido: de ahora en más no vas a recibir más llamadas nuestras. ¡Que tengas un excelente día!' },
  { key: '3', label: 'Contactarme más adelante', action: 'FOLLOW_UP', replyMessage: '¡Perfecto! Te contactaremos más adelante. Muchas gracias por tu interés.' }
];

const CRM_STAGES = ['Abiertas', 'Pendientes', 'Clientes', 'Interesados', 'Cerradas'];
const isAllowed = (c: AudContact) => c.callConsentStatus === 'GRANTED' && !c.callOptedOutAt;
const formatPhone = (p: string | null) => (p ? (/^\d{8,}$/.test(p) ? `+${p}` : p) : 'Sin teléfono');

export function CallCampaignWizard({ accounts, audios, onClose, onCreated, mode = 'create', source }: { accounts: CallAccount[]; audios: CallAudio[]; onClose: () => void; onCreated: () => void; mode?: WizardMode; source?: WizardSource }) {
  const src = source?.campaign;
  const redial = Boolean(source?.onlyContactIds);
  const initialScope = redial ? 'custom' : 'all';
  const { user } = useAuth();
  const canAttest = user ? ['OWNER', 'ADMIN', 'SUPERVISOR'].includes(user.role) : false;
  const [step, setStep] = useState(1);
  const [name, setName] = useState(src ? (mode === 'relaunch' ? `${src.name} (${redial ? 'rellamada' : 'relanzada'})` : src.name) : '');
  const [description, setDescription] = useState(src?.description || '');
  const [campaignType, setCampaignType] = useState(src?.campaignType || 'COMMERCIAL');
  const [accountId, setAccountId] = useState((src && accounts.find((a) => a.id === src.account?.id)?.id) || accounts.find((a) => a.status === 'CONNECTED')?.id || accounts[0]?.id || '');
  const [audioId, setAudioId] = useState((src && audios.find((a) => a.id === src.audio?.id)?.id) || audios[0]?.id || '');
  const [contacts, setContacts] = useState<AudContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyNamed, setOnlyNamed] = useState(false);
  const [onlyAllowed, setOnlyAllowed] = useState(false);
  const [scope, setScope] = useState<'all' | 'unanswered' | 'custom'>(initialScope);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (!source) return [];
    if (source.onlyContactIds) return source.onlyContactIds;
    return source.recipients.map((r) => r.contactId);
  });
  const [startNow, setStartNow] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [attest, setAttest] = useState(false);
  const [consentSource, setConsentSource] = useState('Clientes que aceptaron ser llamados');
  const [granting, setGranting] = useState(false);
  const [consentMsg, setConsentMsg] = useState<string | null>(null);
  const futureSchedule = mode === 'edit' && src?.scheduledAt && new Date(src.scheduledAt).getTime() > Date.now() ? src.scheduledAt : null;
  const toLocalInput = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const [scheduled, setScheduled] = useState(Boolean(futureSchedule));
  const [scheduledAt, setScheduledAt] = useState(futureSchedule ? toLocalInput(futureSchedule) : '');
  const [pause, setPause] = useState(String(src?.pauseBetweenSeconds ?? 10));
  const [maxAttempts, setMaxAttempts] = useState(String(src?.maxAttempts ?? 1));
  const [answerTimeout, setAnswerTimeout] = useState(String(src?.answerTimeoutSeconds ?? 30));
  const [retryDelay, setRetryDelay] = useState(String(src?.retryDelaySeconds ?? 300));
  const [windowFrom, setWindowFrom] = useState(src?.allowedFrom || '');
  const [windowTo, setWindowTo] = useState(src?.allowedTo || '');
  const [surveyEnabled, setSurveyEnabled] = useState(Boolean(src?.surveyEnabled && source?.survey));
  const [question, setQuestion] = useState(source?.survey?.question || src?.surveyQuestion || '¿Desea recibir más información?');
  const [options, setOptions] = useState<SurveyOption[]>(source?.survey?.options?.length ? source.survey.options : DEFAULT_OPTIONS);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Relanzar: elegir a quién se vuelve a llamar (todos, o solo quienes no atendieron la vez anterior).
  function changeScope(next: 'all' | 'unanswered') {
    setScope(next);
    if (!source) return;
    setSelectedIds(source.recipients.filter((r) => next === 'all' || !ANSWERED.has(r.status)).map((r) => r.contactId));
  }

  async function loadContacts() {
    setLoading(true);
    try { setContacts((await apiGet<{ contacts: AudContact[] }>('/api/org/wa-calls/audience')).contacts); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los contactos'); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadContacts(); }, []);

  const crmTagList = useMemo(() => {
    const counts = new Map<string, number>();
    contacts.forEach((c) => c.crmTags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    const order = (t: string) => { const i = CRM_STAGES.indexOf(t); return i < 0 ? 99 : i; };
    return Array.from(counts, ([tag, count]) => ({ tag, count })).sort((a, b) => order(a.tag) - order(b.tag) || a.tag.localeCompare(b.tag));
  }, [contacts]);
  const contactTagList = useMemo(() => {
    const counts = new Map<string, number>();
    contacts.forEach((c) => c.tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    return Array.from(counts, ([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  }, [contacts]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts
      .filter((c) => (!onlyNamed || c.name?.trim()) && (!onlyAllowed || isAllowed(c)) && (!q || `${c.name || ''} ${c.phone || ''} ${c.tags.join(' ')} ${c.crmTags.join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => Number(Boolean(b.name?.trim())) - Number(Boolean(a.name?.trim())) || (a.name || '').localeCompare(b.name || ''))
      .slice(0, 300);
  }, [contacts, search, onlyNamed, onlyAllowed]);

  const audience = useMemo(() => contacts.filter((c) => c.phone && (selectedIds.includes(c.id) || c.tags.some((t) => selectedTags.includes(t)) || c.crmTags.some((t) => selectedTags.includes(t)))), [contacts, selectedIds, selectedTags]);
  const callable = audience.filter(isAllowed);
  const pendingConsent = audience.filter((c) => !c.callOptedOutAt && c.callConsentStatus !== 'GRANTED');
  const optedOut = audience.filter((c) => c.callOptedOutAt);
  const account = accounts.find((a) => a.id === accountId);
  const audio = audios.find((a) => a.id === audioId);
  const minSchedule = useMemo(() => { const d = new Date(Date.now() + 60000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }, []);

  const toggleId = (id: string) => setSelectedIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleTag = (t: string) => setSelectedTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  function toggleVisible() {
    const ids = visible.filter((c) => c.phone && !c.callOptedOutAt).map((c) => c.id);
    const all = ids.length > 0 && ids.every((id) => selectedIds.includes(id));
    setSelectedIds((p) => (all ? p.filter((id) => !ids.includes(id)) : Array.from(new Set([...p, ...ids]))));
  }

  async function grantConsent() {
    setGranting(true); setError(null); setConsentMsg(null);
    try {
      const res = await apiPost<{ granted: number; skippedOptedOut: number }>('/api/org/wa-calls/consent', { contactIds: pendingConsent.map((c) => c.id), confirm: true, source: consentSource });
      setConsentMsg(`Consentimiento registrado para ${res.granted} contacto${res.granted === 1 ? '' : 's'}.`);
      setAttest(false);
      await loadContacts();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudo registrar el consentimiento'); }
    finally { setGranting(false); }
  }

  function validate(target: number) {
    if (target === 1) {
      if (name.trim().length < 2) { setError('Escribí un nombre para la campaña (mínimo 2 letras).'); return false; }
      if (!accountId) { setError('Conectá una cuenta de WhatsApp para poder llamar.'); return false; }
      if (!audioId) { setError('Elegí el audio que se va a reproducir. Podés cargar uno en “Biblioteca de audios”.'); return false; }
    }
    if (target === 2 && callable.length === 0) {
      setError(pendingConsent.length > 0 ? 'Los contactos elegidos todavía no tienen consentimiento registrado. Confirmalo más abajo para poder llamarlos.' : 'Elegí al menos un contacto autorizado para llamar.');
      return false;
    }
    if (target === 3) {
      if (scheduled && (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now())) { setError('Elegí una fecha y hora futura para programar.'); return false; }
      if ((windowFrom && !windowTo) || (!windowFrom && windowTo)) { setError('Completá el horario permitido (desde y hasta) o dejalo vacío.'); return false; }
      if (surveyEnabled && (!question.trim() || options.filter((o) => o.key.trim() && o.label.trim()).length < 2)) { setError('La encuesta necesita una pregunta y al menos dos opciones.'); return false; }
    }
    if (target === 4 && !confirmed) { setError('Confirmá que revisaste el resumen.'); return false; }
    return true;
  }
  async function suggestReplies() {
    setSuggesting(true); setSuggestNote(null); setError(null);
    try {
      const res = await apiPost<{ replies: { key: string; action: SurveyAction; replyMessage: string }[]; usedAi: boolean }>('/api/org/wa-calls/survey/suggest-replies', { question, options: options.filter((o) => o.key.trim() && o.label.trim()).map(({ key, label }) => ({ key, label })) });
      setOptions((cur) => cur.map((o) => { const r = res.replies.find((x) => x.key === o.key); return r ? { ...o, action: r.action, replyMessage: r.replyMessage } : o; }));
      setSuggestNote(res.usedAi ? 'Respuestas redactadas con IA. Revisalas y editalas si querés.' : 'Se cargaron respuestas sugeridas. Editalas a tu gusto.');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'No se pudieron sugerir respuestas'); }
    finally { setSuggesting(false); }
  }
  const next = () => { setError(null); if (validate(step)) setStep((s) => Math.min(STEPS.length, s + 1)); };
  const back = () => { setError(null); setStep((s) => Math.max(1, s - 1)); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step < STEPS.length) return next();
    for (const s of [1, 2, 3, 4]) if (!validate(s)) { setStep(s); return; }
    setBusy(true); setError(null);
    try {
      const payload = {
        name: name.trim(), description: description.trim() || null, campaignType, accountId, audioId,
        contactIds: callable.map((c) => c.id),
        scheduledAt: scheduled ? new Date(scheduledAt).toISOString() : null,
        maxAttempts: Number(maxAttempts), pauseBetweenSeconds: Number(pause), answerTimeoutSeconds: Number(answerTimeout), retryDelaySeconds: Number(retryDelay),
        allowedFrom: windowFrom || null, allowedTo: windowTo || null,
        surveyEnabled, surveyQuestion: surveyEnabled ? question.trim() : null, surveyResponseMethod: 'WHATSAPP',
        surveyOptions: surveyEnabled ? options.filter((o) => o.key.trim() && o.label.trim()).map((o) => ({ key: o.key.trim(), label: o.label.trim(), action: o.action, crmStage: o.crmStage || null, replyMessage: o.replyMessage.trim() || null })) : []
      };
      const saved = mode === 'edit' && src
        ? await apiPatch<{ campaign: CallCampaign }>(`/api/org/wa-calls/campaigns/${src.id}`, payload)
        : await apiPost<{ campaign: CallCampaign }>('/api/org/wa-calls/campaigns', payload);
      if (startNow && !scheduled) await apiPost(`/api/org/wa-calls/campaigns/${saved.campaign.id}/start`, {});
      onCreated();
    } catch (err) { setError(err instanceof ApiError ? err.message : mode === 'edit' ? 'No se pudo guardar la campaña' : 'No se pudo crear la campaña'); setBusy(false); }
  }

  const cur = STEPS[step - 1];
  return (
    <Modal title={mode === 'edit' ? 'Editar campaña de llamadas' : mode === 'relaunch' ? (redial ? 'Rellamar contacto' : 'Relanzar campaña de llamadas') : 'Nueva campaña de llamadas'} onClose={onClose} className="campaign-modal campaign-create-modal">
      <form onSubmit={submit} className="campaign-wizard">
        <div className="campaign-wizard-intro"><span className="campaign-wizard-intro-icon"><Ui name="phone" size={20} /></span><div><strong>Llamadas con audio, controladas</strong><p>Solo se llama a contactos con consentimiento registrado. Cada llamada reproduce el audio elegido y queda en el historial.</p></div></div>
        <nav className="campaign-wizard-progress" style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }} aria-label="Pasos">
          {STEPS.map((s, i) => { const n = i + 1; return <div key={s.label} className={`campaign-wizard-step ${n === step ? 'active' : ''} ${n < step ? 'completed' : ''}`}><span>{n < step ? <Ui name="check" size={12} /> : n}</span><small>{s.short}</small></div>; })}
        </nav>
        <div className="campaign-wizard-heading"><span>PASO {step} DE {STEPS.length}</span><h2>{cur.label}</h2><p>{cur.description}</p></div>

        {step === 1 && (
          <section className="campaign-wizard-panel">
            <div className="campaign-form-grid">
              <div className="field"><label htmlFor="cc-name">Nombre de la campaña</label><input id="cc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Seguimiento comercial septiembre" autoFocus /></div>
              <div className="field"><label htmlFor="cc-type">Tipo</label><select id="cc-type" className="input" value={campaignType} onChange={(e) => setCampaignType(e.target.value)}>{CALL_CAMPAIGN_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></div>
            </div>
            <div className="field" style={{ marginTop: 14 }}><label htmlFor="cc-desc">Descripción interna (opcional)</label><input id="cc-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Objetivo de la llamada" /></div>
            <div className="field" style={{ marginTop: 14 }}><label htmlFor="cc-acc">Línea de WhatsApp que llama</label>
              <select id="cc-acc" className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">Seleccionar cuenta</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.phoneNumber ? ` · +${a.phoneNumber}` : ''} · {a.status === 'CONNECTED' ? 'Conectada' : a.status}</option>)}</select>
              {accounts.length === 0 && <small className="campaign-field-hint warning">No hay cuentas. Conectá una en “Cuentas WhatsApp”.</small>}
              {account && account.status !== 'CONNECTED' && <small className="campaign-field-hint warning">Esta cuenta no está conectada: podés guardar la campaña, pero no va a llamar hasta que la conectes.</small>}
            </div>
            <div className="field" style={{ marginTop: 14 }}><label>Audio a reproducir</label>
              {audios.length === 0 ? <div className="campaign-alert error">Todavía no cargaste ningún audio. Cerrá esta ventana y subí uno en “Biblioteca de audios”.</div> : (
                <div className="cc-audio-list">{audios.map((a) => (
                  <label key={a.id} className={`cc-audio ${audioId === a.id ? 'selected' : ''}`}>
                    <input type="radio" name="cc-audio" checked={audioId === a.id} onChange={() => setAudioId(a.id)} />
                    <span className="cc-audio-icon"><Ui name={a.source === 'AI' ? 'sparkles' : 'volume'} size={18} /></span>
                    <span className="cc-audio-name"><b>{a.name}</b><small>{a.source === 'AI' ? 'Generado con IA' : 'Subido'}{a.durationSeconds ? ` · ${a.durationSeconds}s` : ''}</small></span>
                    <audio controls preload="none" src={a.fileUrl} onClick={(e) => e.stopPropagation()} />
                  </label>))}</div>)}
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="campaign-wizard-panel">
            {mode === 'relaunch' && source && !redial && (
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="cc-scope">A quién volver a llamar</label>
                <select id="cc-scope" className="input" value={scope === 'unanswered' ? 'unanswered' : 'all'} onChange={(e) => changeScope(e.target.value as 'all' | 'unanswered')}>
                  <option value="all">Todos los de la campaña original ({source.recipients.length})</option>
                  <option value="unanswered">Solo los que no atendieron ({source.recipients.filter((r) => !ANSWERED.has(r.status)).length})</option>
                </select>
                <small className="campaign-field-hint">Podés seguir ajustando la lista abajo antes de crear la nueva campaña.</small>
              </div>
            )}
            <div className="cc-summary">
              <span><b>{audience.length}</b> elegidos</span><span className="ok"><b>{callable.length}</b> autorizados</span>
              {pendingConsent.length > 0 && <span className="warn"><b>{pendingConsent.length}</b> sin consentimiento</span>}
              {optedOut.length > 0 && <span className="bad"><b>{optedOut.length}</b> excluidos</span>}
            </div>
            <input className="input campaign-audience-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre, teléfono, etapa o etiqueta…" autoFocus />
            <div className="campaign-audience-tools">
              <button type="button" className="btn secondary small" onClick={toggleVisible} disabled={visible.length === 0}>{visible.length > 0 && visible.filter((c) => c.phone && !c.callOptedOutAt).every((c) => selectedIds.includes(c.id)) ? 'Quitar visibles' : `Seleccionar visibles (${visible.length})`}</button>
              <label className="campaign-only-named"><input type="checkbox" checked={onlyNamed} onChange={(e) => setOnlyNamed(e.target.checked)} /> Solo con nombre</label>
              <label className="campaign-only-named"><input type="checkbox" checked={onlyAllowed} onChange={(e) => setOnlyAllowed(e.target.checked)} /> Solo autorizados</label>
              <button type="button" className="btn secondary small campaign-sync-button" onClick={loadContacts} disabled={loading}><Ui name="refresh" size={14} /> Actualizar</button>
            </div>
            <div className="campaign-tag-group"><span className="campaign-tag-group-label">Etapas del CRM</span><div className="campaign-tags">
              {crmTagList.map(({ tag, count }) => <button type="button" key={`crm-${tag}`} className={`campaign-tag crm ${selectedTags.includes(tag) ? 'active' : ''}`} onClick={() => toggleTag(tag)}><Ui name="tag" size={13} /> {tag} <em>{count}</em></button>)}
              {crmTagList.length === 0 && !loading && <span className="campaign-field-hint">Todavía no hay conversaciones con etapa en el CRM.</span>}
            </div></div>
            {contactTagList.length > 0 && <div className="campaign-tag-group"><span className="campaign-tag-group-label">Etiquetas de contactos</span><div className="campaign-tags">{contactTagList.map(({ tag, count }) => <button type="button" key={`t-${tag}`} className={`campaign-tag ${selectedTags.includes(tag) ? 'active' : ''}`} onClick={() => toggleTag(tag)}># {tag} <em>{count}</em></button>)}</div></div>}
            <div className="campaign-contact-picker">
              {loading ? <div className="campaign-picker-loading">Cargando contactos…</div> : visible.length === 0 ? <div className="campaign-picker-loading">{contacts.length === 0 ? 'No hay contactos con teléfono. Sincronizá tu teléfono en Contactos.' : 'No hay contactos con esa búsqueda.'}</div> : visible.map((c) => {
                const picked = selectedIds.includes(c.id) || c.tags.some((t) => selectedTags.includes(t)) || c.crmTags.some((t) => selectedTags.includes(t));
                const st = c.callOptedOutAt ? { label: 'Excluido', cls: 'bad' } : c.callConsentStatus === 'GRANTED' ? { label: 'Autorizado', cls: 'ok' } : { label: 'Sin consentimiento', cls: 'warn' };
                return (
                  <button type="button" key={c.id} className={`campaign-contact-row ${picked ? 'selected' : ''}`} onClick={() => toggleId(c.id)} disabled={Boolean(c.callOptedOutAt)}>
                    <span className="campaign-check">{picked ? <Ui name="check" size={12} /> : ''}</span>
                    <ContactAvatar contact={c} size={36} />
                    <span className="campaign-contact-name"><b>{c.name?.trim() || formatPhone(c.phone)}</b><small>{c.name?.trim() ? formatPhone(c.phone) : 'Sin nombre guardado'}{c.crmTags[0] ? ` · ${c.crmTags[0]}` : ''}</small></span>
                    <span className={`cc-badge ${st.cls}`}>{st.label}</span>
                  </button>);
              })}
            </div>
            {pendingConsent.length > 0 && (canAttest ? (
              <div className="cc-consent">
                <div className="cc-consent-head"><Ui name="shield" size={20} /><div><strong>{pendingConsent.length} contacto{pendingConsent.length === 1 ? '' : 's'} sin consentimiento registrado</strong><small>Por política de WhatsApp y de protección de datos, solo se llama a quienes aceptaron recibir llamadas.</small></div></div>
                <label className="field"><span>¿Cómo aceptaron?</span><input className="input" value={consentSource} onChange={(e) => setConsentSource(e.target.value)} maxLength={120} placeholder="Ej. Aceptaron por WhatsApp / formulario web" /></label>
                <label className="cc-attest"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> <span>Declaro que estas personas aceptaron ser llamadas y que ofrezco una forma de dejar de recibir llamadas. Queda registrado con mi usuario y la fecha.</span></label>
                <button type="button" className="btn" disabled={!attest || granting || !consentSource.trim()} onClick={grantConsent}>{granting ? 'Registrando…' : `Confirmar consentimiento de ${pendingConsent.length}`}</button>
              </div>
            ) : <div className="campaign-wizard-tip"><span><Ui name="info" size={18} /></span><p>{pendingConsent.length} contacto(s) elegidos no tienen consentimiento registrado. Pedile a un supervisor o administrador que lo confirme.</p></div>)}
            {consentMsg && <div className="campaign-sync-success"><Ui name="check" size={14} /> {consentMsg}</div>}
          </section>
        )}

        {step === 3 && (
          <section className="campaign-wizard-panel">
            <div className="campaign-campaign-type-grid">
              <button type="button" className={`campaign-campaign-type ${!scheduled ? 'selected' : ''}`} onClick={() => setScheduled(false)}><span><Ui name="play" size={16} /></span><div><strong>Manual</strong><small>Queda lista y la iniciás vos con “Iniciar”.</small></div></button>
              <button type="button" className={`campaign-campaign-type ${scheduled ? 'selected' : ''}`} onClick={() => setScheduled(true)}><span><Ui name="calendar" size={16} /></span><div><strong>Programada</strong><small>Comienza sola en la fecha y hora elegidas.</small></div></button>
            </div>
            {scheduled && <div className="field campaign-schedule-field"><label htmlFor="cc-when">Fecha y hora de inicio</label><input id="cc-when" type="datetime-local" min={minSchedule} className="input" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} /></div>}
            <div className="cc-rules">
              <div className="field"><label>Pausa entre llamadas (seg)</label><input className="input" type="number" min={0} max={3600} value={pause} onChange={(e) => setPause(e.target.value)} /><small className="campaign-field-hint">Espacio entre una llamada y la siguiente.</small></div>
              <div className="field"><label>Intentos por contacto</label><select className="input" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)}><option value="1">1 intento</option><option value="2">2 intentos</option><option value="3">3 intentos</option></select></div>
              <div className="field"><label>Tiempo para contestar (seg)</label><input className="input" type="number" min={10} max={180} value={answerTimeout} onChange={(e) => setAnswerTimeout(e.target.value)} /></div>
              <div className="field"><label>Reintentar después de (seg)</label><input className="input" type="number" min={30} max={86400} value={retryDelay} onChange={(e) => setRetryDelay(e.target.value)} disabled={maxAttempts === '1'} /></div>
              <div className="field"><label>Horario permitido: desde</label><input className="input" type="time" value={windowFrom} onChange={(e) => setWindowFrom(e.target.value)} /></div>
              <div className="field"><label>hasta</label><input className="input" type="time" value={windowTo} onChange={(e) => setWindowTo(e.target.value)} /></div>
            </div>
            <small className="campaign-field-hint">Sin horario, llama a cualquier hora del día. Se recomienda respetar horarios razonables (por ejemplo 08:00 a 20:00).</small>
            <label className="cc-attest" style={{ marginTop: 16 }}><input type="checkbox" checked={surveyEnabled} onChange={(e) => setSurveyEnabled(e.target.checked)} /> <span><b>Enviar una encuesta por WhatsApp después de la llamada</b><br /><small>La respuesta queda asociada al contacto y a la llamada.</small></span></label>
            {surveyEnabled && (
              <div className="cc-survey">
                <div className="cc-survey-intro"><Ui name="info" size={16} /><span>Cuando el cliente conteste con el número de una opción, el sistema <b>le responde solo</b> con el mensaje que definas y aplica la acción elegida.</span></div>
                <div className="field"><label>Pregunta</label><input className="input" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} /></div>
                <div className="cc-survey-ai"><button type="button" className="btn secondary small" onClick={suggestReplies} disabled={suggesting}><Ui name="sparkles" size={14} /> {suggesting ? 'Redactando…' : 'Sugerir respuestas con IA'}</button>{suggestNote && <small>{suggestNote}</small>}</div>
                {options.map((o, i) => (
                  <div className="cc-option-card" key={i}>
                    <div className="cc-option">
                      <input className="input" value={o.key} maxLength={10} onChange={(e) => setOptions((cur) => cur.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} aria-label="Número de opción" />
                      <input className="input" value={o.label} maxLength={120} onChange={(e) => setOptions((cur) => cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Texto de la opción" placeholder="Texto de la opción" />
                      <button type="button" className="btn secondary small" onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))} disabled={options.length <= 2} aria-label="Quitar opción"><Ui name="x" size={14} /></button>
                    </div>
                    <div className="cc-option-reply">
                      <label><span>Si elige esta opción</span>
                        <select className="input" value={o.action} onChange={(e) => setOptions((cur) => cur.map((x, j) => (j === i ? { ...x, action: e.target.value as SurveyAction } : x)))}>{ACTIONS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</select></label>
                      <label><span>Enviar al embudo de ventas (CRM)</span>
                        <select className="input" value={o.crmStage || ''} onChange={(e) => setOptions((cur) => cur.map((x, j) => (j === i ? { ...x, crmStage: e.target.value as CrmStage | '' } : x)))}>
                          <option value="">{o.action === 'INTERESTED' ? 'Interesados (por defecto)' : 'No mover'}</option>
                          {CRM_STAGE_DEFS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select></label>
                      <label><span>Respuesta automática por WhatsApp</span>
                        <textarea className="input" rows={2} maxLength={1000} value={o.replyMessage} onChange={(e) => setOptions((cur) => cur.map((x, j) => (j === i ? { ...x, replyMessage: e.target.value } : x)))} placeholder="Si lo dejás vacío se usa un mensaje de agradecimiento por defecto." /></label>
                    </div>
                  </div>))}
                <button type="button" className="btn secondary small" onClick={() => setOptions((cur) => [...cur, { key: String(cur.length + 1), label: '', action: 'NONE', replyMessage: '' }])} disabled={options.length >= 10}><Ui name="plus" size={14} /> Agregar opción</button>
              </div>)}
          </section>
        )}

        {step === 4 && (
          <section className="campaign-wizard-panel campaign-review-panel">
            <div className="campaign-review-status"><span><Ui name={scheduled ? 'calendar' : 'clock'} size={16} /></span><div><strong>{scheduled ? 'Quedará programada' : 'Quedará lista para iniciar'}</strong><small>{scheduled ? `Inicio: ${new Date(scheduledAt).toLocaleString('es-PY', { dateStyle: 'medium', timeStyle: 'short' })}` : 'La iniciás desde su tarjeta con “Iniciar”.'}</small></div></div>
            <div className="campaign-review-grid">
              <div><span>CAMPAÑA</span><strong>{name}</strong><small>{CALL_CAMPAIGN_TYPES.find((t) => t.key === campaignType)?.label}</small></div>
              <div><span>LÍNEA</span><strong>{account?.name || '—'}</strong><small>{account?.status === 'CONNECTED' ? 'Conectada' : 'No conectada'}</small></div>
              <div><span>AUDIO</span><strong>{audio?.name || '—'}</strong></div>
              <div><span>DESTINATARIOS</span><strong>{callable.length} contactos</strong><small>{audience.length - callable.length > 0 ? `${audience.length - callable.length} se omiten (sin consentimiento o excluidos)` : 'Todos autorizados'}</small></div>
              <div><span>RITMO</span><strong>{pause}s entre llamadas</strong><small>{maxAttempts} intento(s) · {answerTimeout}s para contestar</small></div>
              <div><span>HORARIO</span><strong>{windowFrom && windowTo ? `${windowFrom} a ${windowTo}` : 'Sin restricción'}</strong><small>{surveyEnabled ? 'Con encuesta posterior' : 'Sin encuesta'}</small></div>
            </div>
            {audio && <div className="cc-review-audio"><span>Así suena el audio</span><audio controls preload="none" src={audio.fileUrl} /></div>}
            <div className="cc-review-list">{callable.slice(0, 8).map((c) => <span key={c.id}>{c.name?.trim() || formatPhone(c.phone)}</span>)}{callable.length > 8 && <span>+{callable.length - 8} más</span>}</div>
            <label className="campaign-review-confirm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> <span>Revisé el audio, los destinatarios y las reglas. {mode === 'edit' ? 'Quiero guardar estos cambios.' : 'Quiero crear esta campaña.'}</span></label>
            {!scheduled && <label className="campaign-review-confirm"><input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} /> <span>Iniciar las llamadas apenas se guarde.</span></label>}
          </section>
        )}

        {error && <div className="campaign-alert error campaign-wizard-error">{error}</div>}
        <div className="campaign-wizard-footer"><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button>
          <div className="campaign-wizard-actions">
            {step > 1 && <button type="button" className="btn secondary" onClick={back} disabled={busy}><Ui name="arrow-left" size={14} /> Atrás</button>}
            {step < STEPS.length ? <button type="button" className="btn" onClick={next} disabled={busy || (step === 2 && loading)}>Siguiente <Ui name="arrow-right" size={14} /></button> : <button type="submit" className="btn" disabled={busy}>{busy ? 'Guardando…' : mode === 'edit' ? (startNow && !scheduled ? 'Guardar e iniciar' : 'Guardar cambios') : startNow && !scheduled ? 'Crear e iniciar' : scheduled ? 'Crear campaña programada' : mode === 'relaunch' ? 'Crear nueva campaña' : 'Crear campaña'}</button>}
          </div>
        </div>
      </form>
    </Modal>
  );
}
