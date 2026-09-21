// SMS: mismas reglas que el servidor (api/src/lib/smsText.js) para mostrar el contador y el costo en vivo.
// El servidor siempre vuelve a validar; esto es solo para que la persona vea lo que va a pasar.
export const GSM_LIMIT = 160;
export const UCS2_LIMIT = 70;
export const SMS_PRICE_FALLBACK = 130;

const GSM_EXTENDED = new Set(['^', '{', '}', '\\', '[', ']', '~', '|']);
const CHAR_MAP: Record<string, string> = { '¿': '?', '¡': '!', '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '´': "'", '`': "'", '–': '-', '—': '-', '…': '...', '€': 'EUR', '°': 'o', 'º': 'o', 'ª': 'a', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'œ': 'oe', 'Œ': 'OE', '\t': ' ' };

export function stripToAscii(text: string) {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E\n]/g, (ch) => (ch in CHAR_MAP ? CHAR_MAP[ch] : ''))
    .replace(/ {2,}/g, ' ')
    .trim();
}

export interface SmsAnalysis { text: string; encoding: 'gsm7' | 'ucs2'; length: number; limit: number; segments: number; fits: boolean }

export function analyzeText(text: string, stripAccents = true): SmsAnalysis {
  let value = text.replace(/\r\n/g, '\n');
  if (stripAccents) value = stripToAscii(value);
  const ascii = /^[\x20-\x7E\n]*$/.test(value);
  const length = ascii ? [...value].reduce((total, ch) => total + (GSM_EXTENDED.has(ch) ? 2 : 1), 0) : value.length;
  const limit = ascii ? GSM_LIMIT : UCS2_LIMIT;
  return { text: value, encoding: ascii ? 'gsm7' : 'ucs2', length, limit, segments: length <= limit ? 1 : Math.ceil(length / (ascii ? 153 : 67)), fits: length > 0 && length <= limit };
}

// Igual que las campañas de WhatsApp: {{nombre}} o {nombre} (primer nombre), {{nombre|amigo}} con respaldo.
export function personalize(template: string, name: string | null | undefined) {
  const full = /\p{L}/u.test(name || '') ? String(name).trim() : '';
  const first = full.split(/\s+/)[0] || '';
  return template
    .replace(/\{\{?\s*(nombre_completo|nombre completo|nombre|name)\s*(?:\|\s*([^{}]*?)\s*)?\}\}?/gi, (_m, key: string, fallback?: string) => {
      const k = key.toLowerCase();
      const value = k === 'nombre' || k === 'name' ? first : full;
      return value || fallback || 'cliente';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1');
}

export function normalizePyPhone(raw: string | null | undefined): string | null {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('5950')) digits = `595${digits.slice(4)}`;
  if (digits.startsWith('595')) { /* ya tiene el código de país */ }
  else if (digits.startsWith('0')) digits = `595${digits.slice(1)}`;
  else if (digits.length === 9) digits = `595${digits}`;
  return /^5959\d{8}$/.test(digits) ? digits : null;
}

export const formatPhone = (phone: string | null | undefined) => {
  const p = String(phone || '');
  return /^5959\d{8}$/.test(p) ? `+595 ${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : p || '—';
};
export const gs = (value: number) => `Gs. ${Math.round(value).toLocaleString('es-PY')}`;
export const num = (value: number) => value.toLocaleString('es-PY');

export interface SmsCounts { total: number; pending: number; sending: number; sent: number; delivered: number; failed: number; cancelled: number; ok: number }
export type SmsCampaignStatus = 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export interface SmsCampaign {
  id: string; name: string; message: string; stripAccents: boolean; source: 'CAMPAIGN' | 'QUICK'; status: SmsCampaignStatus; pauseReason: string | null;
  scheduledAt: string | null; startedAt: string | null; completedAt: string | null; createdAt: string; updatedAt: string; counts: SmsCounts | null;
}
export type SmsMessageStatus = 'PENDING' | 'SENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'CANCELLED';
export interface SmsMessage {
  id: string; campaignId: string | null; campaignName?: string | null; name: string | null; phone: string; body: string; encoding: string;
  status: SmsMessageStatus; error: string | null; credits: number; sentAt: string | null; deliveredAt: string | null; createdAt: string;
}
export interface SmsPurchase { id: string; credits: number; unitPrice: number; amount: number; status: 'pending' | 'paid' | 'failed' | 'expired'; source: 'CARD' | 'ADMIN'; paymentUrl: string | null; paymentMethod: string | null; note: string | null; paidAt: string | null; createdAt: string }
export interface SmsTransaction { id: string; type: 'PURCHASE' | 'CONSUMPTION' | 'REFUND' | 'ADJUSTMENT'; amount: number; balanceAfter: number; note: string | null; createdAt: string }
export interface SmsOverview {
  balance: number; priceGs: number; packages: number[]; minPurchase: number; maxPurchase: number; providerReady: boolean;
  range: { from: string; to: string };
  totals: { ok: number; failed: number; pending: number; delivered: number; total: number };
  creditsUsed: number; purchased: { credits: number; amount: number }; activeCampaigns: number;
  daily: { day: string; ok: number; failed: number }[]; recentCampaigns: SmsCampaign[]; organization: string | null;
}
export interface ParsedList {
  rows: { line: number; raw: string; name: string | null; phone: string | null; valid: boolean; reason: string | null }[]; truncated: boolean;
  summary: { total: number; valid: number; invalid: number; duplicates: number }; recipients: { name: string | null; phone: string }[];
}
export interface SmsAudienceContact { id: string; name: string | null; phone: string; sms: string | null; tags: string[] }
