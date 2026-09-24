import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiPost, ApiError } from '../lib/api';
import { formatPhone, type ParsedList } from '../lib/sms';
import { Ui } from './Ui';
import '../styles/sms.css';

// Pegar números (uno por línea) o subir un TXT/CSV con "nombre,número". El servidor lee la lista y dice qué sirve.
export function SmsListInput({ value, onChange, onParsed, placeholder, endpoint = '/api/org/sms/parse-list', help }: {
  value: string; onChange: (text: string) => void; onParsed: (parsed: ParsedList | null) => void; placeholder?: string;
  endpoint?: string; help?: ReactNode;
}) {
  const [parsed, setParsed] = useState<ParsedList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!value.trim()) { setParsed(null); setError(null); onParsed(null); return; }
    const mine = ++seq.current;
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiPost<ParsedList>(endpoint, { text: value });
        if (mine !== seq.current) return;
        setParsed(res); setError(null); onParsed(res);
      } catch (err) {
        if (mine !== seq.current) return;
        setError(err instanceof ApiError ? err.message : 'No se pudo leer la lista'); onParsed(null);
      }
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  async function onFile(file: File | null) {
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) { setError('El archivo es muy grande (máximo 1,5 MB).'); return; }
    setFileName(file.name);
    onChange(await file.text());
  }

  return (
    <div className="sms-list-input">
      <textarea className="input sms-list-text" rows={7} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false}
        placeholder={placeholder || 'Pegá los números, uno por línea:\n0985 768 793\n0981 222 333\n\nO con nombre (nombre,número):\nAna Pérez,0985768793\nBeto,981222333'} aria-label="Lista de números" />
      <div className="sms-list-tools">
        <label className="btn secondary small sms-file-btn"><Ui name="paperclip" size={14} /> Subir archivo TXT o CSV
          <input type="file" accept=".txt,.csv,text/plain,text/csv" onChange={(e) => onFile(e.target.files?.[0] || null)} hidden /></label>
        {fileName && <small className="sms-file-name">{fileName}</small>}
        {value && <button type="button" className="btn secondary small" onClick={() => { onChange(''); setFileName(null); }}>Limpiar</button>}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {parsed && (
        <div className="sms-parsed">
          <div className="sms-parsed-chips">
            <span className="ok"><b>{parsed.summary.valid}</b> válidos</span>
            {parsed.summary.invalid > 0 && <span className="bad"><b>{parsed.summary.invalid}</b> inválidos</span>}
            {parsed.summary.duplicates > 0 && <span className="warn"><b>{parsed.summary.duplicates}</b> repetidos</span>}
          </div>
          {parsed.summary.invalid + parsed.summary.duplicates > 0 && (
            <details className="sms-parsed-details">
              <summary>Ver los que no se van a usar</summary>
              <ul>{parsed.rows.filter((r) => !r.valid).slice(0, 50).map((r) => <li key={r.line}><b>Línea {r.line}:</b> {r.raw.slice(0, 40)} <small>— {r.reason}</small></li>)}</ul>
            </details>
          )}
          {parsed.summary.valid > 0 && (
            <details className="sms-parsed-details">
              <summary>Vista previa de los números</summary>
              <ul>{parsed.rows.filter((r) => r.valid).slice(0, 8).map((r) => <li key={r.line}>{r.name ? <b>{r.name}</b> : <i>Sin nombre</i>} · {formatPhone(r.phone)}</li>)}</ul>
            </details>
          )}
        </div>
      )}
      {help ?? <small className="sms-list-help">Celulares de Paraguay. Se acepta <b>0985 768 793</b>, <b>985768793</b> o <b>+595 985 768 793</b>: siempre se envía como <b>595985768793</b>.</small>}
    </div>
  );
}
