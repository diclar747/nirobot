import { createContext, useCallback, useContext, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { Modal } from '../components/Modal';
import { Ui } from '../components/Ui';
import { useAlerts } from './AlertContext';
import type { Conversation } from '../types';
import { KIND_LABEL, formatAmountInput, parseAmountInput, type OutcomeCategory, type OutcomeInput } from '../lib/management';
import '../styles/management.css';

interface RequestOptions { closing: boolean; contactName?: string | null }
// null: el agente canceló · undefined: la empresa no tiene categorías, se sigue sin formulario · objeto: lo elegido.
type OutcomeResult = OutcomeInput | null | undefined;

interface OutcomeContextValue {
  requestOutcome: (options: RequestOptions) => Promise<OutcomeResult>;
  /** PATCH de una conversación. Si la deja resuelta/cerrada, pide antes cómo terminó (venta, perdida, cotización…). null = canceló. */
  patchConversation: (conversation: Conversation, body: Record<string, unknown>) => Promise<{ conversation: Conversation } | null>;
  /** Registra una gestión (p. ej. "cotización enviada") sin cerrar el chat. */
  registerOutcome: (conversation: Conversation) => Promise<boolean>;
}

const OutcomeContext = createContext<OutcomeContextValue | null>(null);
const CLOSED = ['RESOLVED', 'CLOSED'];

interface DialogState { options: RequestOptions; categories: OutcomeCategory[]; resolve: (value: OutcomeResult) => void }

export function OutcomeProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const { notify } = useAlerts();

  const requestOutcome = useCallback(async (options: RequestOptions): Promise<OutcomeResult> => {
    let categories: OutcomeCategory[] = [];
    try {
      categories = (await apiGet<{ categories: OutcomeCategory[] }>('/api/org/management/categories')).categories;
    } catch {
      categories = [];
    }
    if (categories.length === 0) return undefined;
    return new Promise<OutcomeResult>((resolve) => setDialog({ options, categories, resolve }));
  }, []);

  const finish = (value: OutcomeResult) => {
    dialog?.resolve(value);
    setDialog(null);
  };

  const patchConversation = useCallback(async (conversation: Conversation, body: Record<string, unknown>) => {
    const url = `/api/org/conversations/${conversation.id}`;
    const closing = typeof body.status === 'string' && CLOSED.includes(body.status) && !CLOSED.includes(conversation.status);
    let outcome: OutcomeResult;
    if (closing) {
      outcome = await requestOutcome({ closing: true, contactName: conversation.contact?.name });
      if (outcome === null) return null;
    }
    try {
      return await apiPatch<{ conversation: Conversation }>(url, { ...body, ...(outcome ? { outcome } : {}) });
    } catch (err) {
      // Se crearon categorías después de abrir la pantalla: pedimos el resultado y reintentamos una vez.
      if (closing && !outcome && err instanceof ApiError && err.code === 'OUTCOME_REQUIRED') {
        const retry = await requestOutcome({ closing: true, contactName: conversation.contact?.name });
        if (!retry) return null;
        return apiPatch<{ conversation: Conversation }>(url, { ...body, outcome: retry });
      }
      throw err;
    }
  }, [requestOutcome]);

  const registerOutcome = useCallback(async (conversation: Conversation) => {
    const outcome = await requestOutcome({ closing: false, contactName: conversation.contact?.name });
    if (!outcome) return false;
    try {
      await apiPost(`/api/org/conversations/${conversation.id}/outcome`, outcome);
      notify('Gestión registrada.', { tone: 'success' });
      return true;
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'No se pudo registrar la gestión', { tone: 'error' });
      return false;
    }
  }, [requestOutcome, notify]);

  const value = useMemo(() => ({ requestOutcome, patchConversation, registerOutcome }), [requestOutcome, patchConversation, registerOutcome]);
  return (
    <OutcomeContext.Provider value={value}>
      {children}
      {dialog && <OutcomeDialog state={dialog} onDone={finish} />}
    </OutcomeContext.Provider>
  );
}

export function useOutcome() {
  const ctx = useContext(OutcomeContext);
  if (!ctx) throw new Error('useOutcome debe usarse dentro de OutcomeProvider');
  return ctx;
}

function OutcomeDialog({ state, onDone }: { state: DialogState; onDone: (value: OutcomeResult) => void }) {
  const { options, categories } = state;
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const category = categories.find((item) => item.id === categoryId);
  const needsAmount = Boolean(category && (category.requiresAmount || category.kind === 'WON'));
  const allowsAmount = Boolean(category && category.kind !== 'LOST');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!category) { setError('Elegí cómo terminó la conversación.'); return; }
    const parsed = parseAmountInput(amount);
    if (needsAmount && !parsed) { setError('Ingresá el monto de la venta.'); return; }
    onDone({ categoryId: category.id, amount: allowsAmount ? parsed : null, note: note.trim() || null });
  }

  return (
    <Modal title={options.closing ? 'Cerrar conversación' : 'Registrar gestión'} onClose={() => onDone(null)} className="outcome-modal">
      <form onSubmit={submit} className="outcome-form">
        <p className="outcome-lead">
          {options.closing ? <>¿Cómo terminó la conversación con <b>{options.contactName || 'este contacto'}</b>?</> : <>Registrá el avance con <b>{options.contactName || 'este contacto'}</b> (por ejemplo, una cotización enviada).</>} Queda a tu nombre para el análisis de gestión.
        </p>
        <div className="outcome-options" role="radiogroup" aria-label="Resultado">
          {categories.map((item) => (
            <button type="button" key={item.id} role="radio" aria-checked={item.id === categoryId} className={`outcome-option ${item.id === categoryId ? 'selected' : ''}`} onClick={() => { setCategoryId(item.id); setError(null); }}>
              <i style={{ background: item.color }} aria-hidden="true" />
              <span><b>{item.name}</b><small>{KIND_LABEL[item.kind]}</small></span>
              {item.id === categoryId && <Ui name="check" size={16} />}
            </button>
          ))}
        </div>
        {allowsAmount && (
          <div className="field">
            <label htmlFor="outcome-amount">{needsAmount ? 'Monto de la venta (Gs.)' : 'Monto (Gs., opcional)'}</label>
            <input id="outcome-amount" className="input" inputMode="numeric" autoComplete="off" placeholder="0" value={amount} onChange={(e) => { setAmount(formatAmountInput(e.target.value)); setError(null); }} />
          </div>
        )}
        {category && (
          <div className="field">
            <label htmlFor="outcome-note">{category.kind === 'LOST' ? 'Motivo (opcional)' : 'Nota (opcional)'}</label>
            <textarea id="outcome-note" className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={category.kind === 'LOST' ? 'Ej.: eligió otra marca, precio…' : 'Ej.: pagó al contado, presupuesto n.º 123…'} />
          </div>
        )}
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="outcome-actions">
          <button type="button" className="btn secondary" onClick={() => onDone(null)}>Cancelar</button>
          <button type="submit" className="btn">{options.closing ? 'Cerrar conversación' : 'Registrar gestión'}</button>
        </div>
      </form>
    </Modal>
  );
}
