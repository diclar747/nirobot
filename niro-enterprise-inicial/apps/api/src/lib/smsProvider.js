// Proveedor de SMS: API REST de Winsap ("SMS Premium"). Autenticación con X-API-Key (clave con alcance SMS).
const crypto = require('crypto');

function baseUrl() { return (process.env.WINSAP_BASE_URL || 'https://winsap.com.py').replace(/\/$/, ''); }
function configured() { return Boolean(process.env.WINSAP_SMS_API_KEY); }

class SmsProviderError extends Error {
  constructor(message, { status = 0, outOfCredit = false } = {}) {
    super(message);
    this.status = status;
    this.outOfCredit = outOfCredit;
  }
}

async function request(method, path, body) {
  if (!configured()) throw new SmsProviderError('El envío de SMS todavía no está configurado', { status: 503 });
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: { 'X-API-Key': process.env.WINSAP_SMS_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000)
    });
  } catch (err) {
    throw new SmsProviderError('No se pudo conectar con el proveedor de SMS', { status: 0 });
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success === false) {
    const message = String((json && (json.error || json.message)) || `Error ${res.status} del proveedor de SMS`);
    // Sin crédito en la cuenta del proveedor: no es culpa del mensaje, hay que pausar y avisar al administrador.
    const outOfCredit = res.status === 402 || /saldo|balance|insufficient|cr[eé]dito/i.test(message);
    throw new SmsProviderError(message, { status: res.status, outOfCredit });
  }
  return json;
}

// Envía un SMS. `to` en formato 595XXXXXXXXX. Devuelve el id del proveedor y cuánto consumió.
async function sendSms({ to, message }) {
  const from = String(process.env.WINSAP_SMS_FROM || '').trim();
  const json = await request('POST', '/api/rest/sms/send', { to, message, ...(from ? { from } : {}) });
  return {
    messageId: json.message_id ? String(json.message_id) : null,
    segments: Number(json.segments) || 1,
    encoding: json.encoding || null,
    cost: json.cost !== undefined ? Number(json.cost) : null,
    remaining: json.remaining_balance !== undefined ? Number(json.remaining_balance) : null
  };
}

async function getBalance() {
  const json = await request('GET', '/api/rest/sms/balance');
  const data = json.data || {};
  return { balance: Number(data.balance) || 0, unitCost: Number(data.unit_cost) || 1, charLimit: Number(data.messages_char_limit) || 160 };
}

async function registerWebhook(url, secret, events = ['sms.delivered', 'sms.failed']) {
  return request('POST', '/api/rest/sms/webhooks', { url, secret, events });
}

// Token del webhook de entrega: va en la URL registrada, así solo el proveedor (que la conoce) puede llamarla.
function webhookToken() {
  const secret = process.env.WINSAP_WEBHOOK_SECRET || crypto.createHash('sha256').update(`niro-winsap:${process.env.JWT_SECRET || ''}`).digest('hex');
  return crypto.createHmac('sha256', secret).update('sms-delivery').digest('hex').slice(0, 40);
}
function verifyWebhookToken(token) {
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(webhookToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { configured, sendSms, getBalance, registerWebhook, webhookToken, verifyWebhookToken, SmsProviderError };
