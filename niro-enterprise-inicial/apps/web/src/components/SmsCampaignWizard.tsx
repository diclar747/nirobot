import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { Modal } from './Modal';
import { Ui } from './Ui';
import { SmsListInput } from './SmsListInput';
import { analyzeText, formatPhone, gs, normalizePyPhone, num, personalize, type ParsedList, type SmsAudienceContact, type SmsCampaign } from '../lib/sms';
import '../styles/sms.css';

const STEPS = [
  { short: 'Mensaje', label: 'Mensaje', description: 'Escribí el texto del SMS. Hasta 160 caracteres: cada destinatario consume 1 SMS de tu saldo.' },
  { short: 'Contactos', label: 'Destinatarios', description: 'Elegí a quién enviarle: contactos de tu CRM, o pegá/subí una lista de números.' },
  { short: 'Envío', label: 'Cuándo enviar', description: 'La campaña queda guardada con un botón para enviarla cuando quieras, o la programás para una fecha.' },
  { short: 'Revisar', label: 'Revisión', description: 'Verificá el mensaje, la cantidad de SMS y el costo. Todavía no se envía nada.' }
];

export interface WizardSource { campaign: SmsCampaign; recipients: { name: string | null; phone: string }[] }
export interface NeedBalance { missing: number; campaignId?: string }

export function SmsCampaignWizard({ mode, source, balance, priceGs, onClose, onDone, onNeedBalance }: {
  mode: 'create' | 'edit' | 'duplicate'; source?: WizardSource; balance: number; priceGs: number;
  onClose: () => void; onDone: (info: { edited: boolean; scheduled: boolean; recipients: number; name: string }) => void; onNeedBalance: (need: NeedBalance) => void;
}) {
  const src = source?.campaign;
  const [step, setStep] = useState(1);
  const [name, setName] = useState(src ? (mode === 'duplicate' ? `${src.name} (copia)` : src.name) : '');
  const [message, setMessage] = useState(src?.message || '');
  const [stripAccents, setStripAccents] = useState(src ? src.stripAccents : true);
  const [tab, setTab] = useState<'crm' | 'list'>('crm');
  const [contacts, setContacts] = useState<SmsAudienceContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [listText, setListText] = useState('');
  const [parsed, setParsed] = useState<ParsedList | null>(null);
  const [saveToCrm, setSaveToCrm] = useState(false);
  const [prefill, setPrefill] = useState<{ name: string | null; phone: string }[]>(source?.recipients || []);
  const [scheduled, setScheduled] = useState(Boolean(src?.status === 'SCHEDULED' && src.scheduledAt && new Date(src.scheduledAt).getTime() > Date.now()));
  const [scheduledAt, setScheduledAt] = useState(() => {
    if (!(src?.status === 'SCHEDULED' && src.scheduledAt && new Date(src.scheduledAt).getTime() > Date.now())) return '';
    const d = new Date(src.scheduledAt); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ contacts: SmsAudienceContact[] }>('/api/org/sms/audience').then((d) => setContacts(d.contacts)).catch(() => {}).finally(() => setLoadingContacts(false));
  }, []);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    contacts.forEach((c) => c.tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  }, [contacts]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter((c) => !q || `${c.name || ''} ${c.phone} ${c.tags.join(' ')}`.toLowerCase().includes(q)).slice(0, 300);
  }, [contacts, search]);

  // Destinatarios finales: sin repetidos, solo celulares válidos de Paraguay.
  const recipients = useMemo(() => {
    const map = new Map<string, string | null>();
    const add = (phone: string | null, nameValue: string | null) => { const p = normalizePyPhone(phone); if (p && !map.has(p)) map.set(p, nameValue); };
    contacts.filter((c) => selectedIds.includes(c.id) || c.tags.some((t) => selectedTags.includes(t))).forEach((c) => add(c.sms, c.name));
    (parsed?.recipients || []).forEach((r) => add(r.phone, r.name));
    prefill.forEach((r) => add(r.phone, r.name));
    return [...map].map(([phone, recipientName]) => ({ phone, name: recipientName }));
  }, [contacts, selectedIds, selectedTags, parsed, prefill]);

  const base = analyzeText(message, stripAccents);
  const tooLong = useMemo(() => (message.trim() ? recipients.filter((r) => !analyzeText(personalize(message, r.name), stripAccents).fits).length : 0), [message, stripAccents, recipients]);
  const sample = personalize(message, recipients.find((r) => r.name)?.name || 'María José');
  const preview = analyzeText(sample, stripAccents);
  const cost = recipients.length * priceGs;
  const missing = Math.max(0, recipients.length - balance);
  const minSchedule = useMemo(() => { const d = new Date(Date.now() + 120000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }, []);

  function validate(target: number) {
    if (target === 1) {
      if (name.trim().length < 2) { setError('Escribí un nombre para la campaña (mínimo 2 letras).'); return false; }
      if (!message.trim()) { setError('Escribí el mensaje.'); return false; }
      if (!base.fits) { setError(`El mensaje supera el límite de ${base.limit} caracteres (tiene ${base.length}).`); return false; }
    }
    if (target === 2) {
      if (recipients.length === 0) { setError('Elegí al menos un destinatario con un celular válido.'); return false; }
      if (tooLong > 0) { setError(`Con el nombre reemplazado, ${tooLong} SMS superan el límite. Acortá el mensaje.`); return false; }
    }
    if (target === 3 && scheduled && (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now() + 60000)) { setError('Elegí una fecha y hora futura para programar.'); return false; }
    if (target === 4 && !confirmed) { setError('Confirmá que revisaste el resumen.'); return false; }
    return true;
  }
  const next = () => { setError(null); if (validate(step)) setStep((s) => Math.min(STEPS.length, s + 1)); };
  const back = () => { setError(null); setStep((s) => Math.max(1, s - 1)); };

  async function submit() {
    for (const s of [1, 2, 3, 4]) if (!validate(s)) { setStep(s); return; }
    setBusy(true); setError(null);
    const payload = {
      name: name.trim(), message, stripAccents,
      contactIds: selectedIds, tagFilter: selectedTags,
      recipients: [...(parsed?.recipients || []), ...prefill].map((r) => ({ name: r.name, phone: r.phone })),
      saveToCrm, scheduledAt: scheduled ? new Date(scheduledAt).toISOString() : null, startNow: false
    };
    try {
      if (mode === 'edit' && src) await apiPatch(`/api/org/sms/campaigns/${src.id}`, payload);
      else await apiPost('/api/org/sms/campaigns', payload);
      onDone({ edited: mode === 'edit', scheduled, recipients: recipients.length, name: payload.name });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === 'SMS_INSUFFICIENT_BALANCE') {
        const data = (err.details || {}) as { missing?: number; campaignId?: string };
        onNeedBalance({ missing: data.missing || missing, campaignId: data.campaignId });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la campaña');
    }
  }

  const toggleId = (id: string) => setSelectedIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleTag = (t: string) => setSelectedTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  const allVisibleSelected = visible.filter((c) => c.sms).length > 0 && visible.filter((c) => c.sms).every((c) => selectedIds.includes(c.id));
  const toggleVisible = () => { const ids = visible.filter((c) => c.sms).map((c) => c.id); setSelectedIds((p) => (allVisibleSelected ? p.filter((id) => !ids.includes(id)) : [...new Set([...p, ...ids])])); };
  const cur = STEPS[step - 1];
  const pctUsed = Math.min(100, Math.round((base.length / base.limit) * 100));

  return (
    <Modal title={mode === 'edit' ? 'Editar campaña de SMS' : mode === 'duplicate' ? 'Duplicar campaña de SMS' : 'Nueva campaña de SMS'} onClose={onClose} className="campaign-modal campaign-create-modal">
      <div className="campaign-wizard">
        <nav className="campaign-wizard-progress" style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }} aria-label="Pasos">
          {STEPS.map((s, i) => { const n = i + 1; return <div key={s.label} className={`campaign-wizard-step ${n === step ? 'active' : ''} ${n < step ? 'completed' : ''}`}><span>{n < step ? <Ui name="check" size={12} /> : n}</span><small>{s.short}</small></div>; })}
        </nav>
        <div className="campaign-wizard-heading"><span>PASO {step} DE {STEPS.length}</span><h2>{cur.label}</h2><p>{cur.description}</p></div>

        {step === 1 && (
          <section className="campaign-wizard-panel">
            <div className="field"><label htmlFor="sms-name">Nombre de la campaña</label><input id="sms-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Promo de septiembre" autoFocus /></div>
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="sms-message">Mensaje</label>
              <textarea id="sms-message" className="input sms-message-input" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Hola {nombre}, tenemos una oferta para vos. Escribinos al 0985 000 000." />
              <div className="sms-counter" aria-live="polite">
                <div className="sms-counter-bar"><span className={base.fits || !message ? '' : 'over'} style={{ width: `${pctUsed}%` }} /></div>
                <span className={base.length > base.limit ? 'over' : ''}><b>{base.length}</b> / {base.limit} caracteres</span>
                <span className="sms-counter-note">{base.encoding === 'ucs2' ? 'Con tildes/ñ el límite baja a 70' : 'Límite: 160 caracteres'}</span>
              </div>
              <label className="auto-chat-option" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={stripAccents} onChange={(e) => setStripAccents(e.target.checked)} />
                <span><b>Quitar tildes y ñ (recomendado)</b><small>Así entran los 160 caracteres. Si lo apagás, con tildes o ñ el límite baja a 70 caracteres.</small></span>
              </label>
              <div className="campaign-variable-bar" style={{ marginTop: 10 }}><span>Insertar dato del contacto:</span>
                <button type="button" className="campaign-variable-chip" onClick={() => setMessage((m) => `${m}{nombre}`)}>＋ Nombre</button></div>
            </div>
            {message.trim() && (
              <div className="sms-phone-preview" aria-label="Vista previa">
                <span>Así lo va a recibir {recipients.find((r) => r.name)?.name ? 'un contacto' : '“María José”'}</span>
                <div className="sms-bubble">{preview.text || '…'}</div>
                <small>{preview.length} caracteres{preview.fits ? '' : ' · supera el límite'}</small>
              </div>
            )}
          </section>
        )}

        {step === 2 && (
          <section className="campaign-wizard-panel">
            <div className="sms-audience-summary"><span><b>{num(recipients.length)}</b> destinatarios válidos</span>{tooLong > 0 && <span className="bad"><b>{tooLong}</b> superan el límite con el nombre</span>}</div>
            <div className="sms-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'crm'} className={tab === 'crm' ? 'active' : ''} onClick={() => setTab('crm')}>Contactos del CRM</button>
              <button type="button" role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>Pegar o subir lista {parsed?.summary.valid ? `(${parsed.summary.valid})` : ''}</button>
            </div>
            {tab === 'crm' ? (
              <>
                {tags.length > 0 && <div className="sms-tag-row" aria-label="Etiquetas">{tags.map((t) => <button type="button" key={t.tag} className={`list-chip ${selectedTags.includes(t.tag) ? 'active' : ''}`} onClick={() => toggleTag(t.tag)}>#{t.tag}<b>{t.count}</b></button>)}</div>}
                <div className="sms-contact-tools">
                  <label className="list-filter-search"><Ui name="search" size={14} /><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre, número o etiqueta…" aria-label="Buscar contacto" /></label>
                  <button type="button" className="btn secondary small" onClick={toggleVisible}>{allVisibleSelected ? 'Quitar visibles' : 'Elegir visibles'}</button>
                </div>
                <div className="sms-contact-list">
                  {loadingContacts ? <p className="sms-empty">Cargando contactos…</p> : visible.length === 0 ? <p className="sms-empty">No hay contactos con teléfono. Podés pegar una lista en la otra pestaña.</p> : visible.map((c) => (
                    <label key={c.id} className={`sms-contact ${c.sms ? '' : 'disabled'}`}>
                      <input type="checkbox" disabled={!c.sms} checked={selectedIds.includes(c.id) || c.tags.some((t) => selectedTags.includes(t))} onChange={() => toggleId(c.id)} />
                      <span className="sms-contact-name"><b>{c.name || 'Sin nombre'}</b><small>{c.sms ? formatPhone(c.sms) : `${c.phone} · no es un celular de Paraguay`}</small></span>
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <>
                {prefill.length > 0 && <div className="alert" style={{ marginBottom: 10 }}><span>Incluye <b>{prefill.length}</b> destinatarios de la campaña original. <button type="button" className="btn secondary small" onClick={() => setPrefill([])}>Quitarlos</button></span></div>}
                <SmsListInput value={listText} onChange={setListText} onParsed={setParsed} />
                <label className="auto-chat-option" style={{ marginTop: 12 }}>
                  <input type="checkbox" checked={saveToCrm} onChange={(e) => setSaveToCrm(e.target.checked)} />
                  <span><b>Guardar estos números en mis contactos</b><small>Los que todavía no estén en tu CRM se agregan con su nombre.</small></span>
                </label>
              </>
            )}
          </section>
        )}

        {step === 3 && (
          <section className="campaign-wizard-panel">
            <div className="sms-when">
              <button type="button" className={`sms-when-option ${!scheduled ? 'selected' : ''}`} onClick={() => setScheduled(false)}><Ui name="send" size={18} /><span><b>La envío yo cuando quiera</b><small>Queda lista con un botón de Enviar.</small></span></button>
              <button type="button" className={`sms-when-option ${scheduled ? 'selected' : ''}`} onClick={() => setScheduled(true)}><Ui name="calendar" size={18} /><span><b>Programar</b><small>Elegí el día y la hora.</small></span></button>
            </div>
            {scheduled && <div className="field" style={{ marginTop: 14 }}><label htmlFor="sms-when">Fecha y hora</label><input id="sms-when" className="input" type="datetime-local" min={minSchedule} value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} /><small className="campaign-field-hint">El saldo se descuenta al enviar cada SMS; tiene que alcanzar cuando llegue la hora.</small></div>}
            <div className="sms-cost">
              <div><span>Destinatarios</span><b>{num(recipients.length)}</b></div>
              <div><span>Costo</span><b>{gs(cost)}</b><small>{num(recipients.length)} × {gs(priceGs)}</small></div>
              <div><span>Tu saldo</span><b className={missing > 0 ? 'bad' : 'ok'}>{num(balance)} SMS</b></div>
            </div>
            {missing > 0 && <div className="alert error" role="alert"><span>Te faltan <b>{num(missing)}</b> SMS para enviar esta campaña. Podés guardarla como borrador y comprar saldo.</span></div>}
          </section>
        )}

        {step === 4 && (
          <section className="campaign-wizard-panel">
            <div className="campaign-review-grid">
              <div><span>CAMPAÑA</span><strong>{name}</strong></div>
              <div><span>DESTINATARIOS</span><strong>{num(recipients.length)} contactos</strong></div>
              <div><span>ENVÍO</span><strong>{scheduled && scheduledAt ? new Date(scheduledAt).toLocaleString('es-PY', { dateStyle: 'medium', timeStyle: 'short' }) : 'Ahora'}</strong></div>
              <div><span>COSTO</span><strong>{num(recipients.length)} SMS · {gs(cost)}</strong><small>{missing > 0 ? `Faltan ${num(missing)} SMS de saldo` : `Te quedan ${num(balance - recipients.length)} SMS`}</small></div>
            </div>
            <div className="sms-phone-preview"><span>Mensaje</span><div className="sms-bubble">{preview.text}</div><small>{preview.length}/{preview.limit} caracteres</small></div>
            <label className="campaign-review-confirm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> <span>Revisé el mensaje y los destinatarios. Entiendo que cada SMS enviado descuenta 1 de mi saldo.</span></label>
          </section>
        )}

        {error && <div className="campaign-alert error campaign-wizard-error">{error}</div>}
        <div className="campaign-wizard-footer"><button type="button" className="btn secondary" onClick={onClose}>Cancelar</button>
          <div className="campaign-wizard-actions">
            {step > 1 && <button type="button" className="btn secondary" onClick={back} disabled={busy}><Ui name="arrow-left" size={14} /> Atrás</button>}
            {step < STEPS.length ? <button type="button" className="btn" onClick={next}>Siguiente <Ui name="arrow-right" size={14} /></button>
              : <button type="button" className="btn" onClick={submit} disabled={busy}>{busy ? 'Guardando…' : mode === 'edit' ? 'Guardar cambios' : scheduled ? 'Programar campaña' : 'Crear campaña'}</button>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
