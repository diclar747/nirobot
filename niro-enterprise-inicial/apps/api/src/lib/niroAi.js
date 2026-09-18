// Cliente de la API de Niro IA (https://niro.cnid.com.py/docs).
//
// Toda la IA del sistema (bot de WhatsApp, transcripción de audios, OCR de facturas, agentes
// propios) pasa por acá. La API key vive solo en el servidor (NIRO_AI_API_KEY) y nunca se expone
// al navegador: el frontend siempre habla con nuestra propia API, que reenvía la llamada.

const DEFAULT_BASE_URL = 'https://niro.cnid.com.py';
const DEFAULT_TIMEOUT_MS = 60000;

class NiroAiError extends Error {
  constructor(message, status, options) {
    super(message);
    this.name = 'NiroAiError';
    this.status = status;
    this.upstreamStatus = (options && options.upstreamStatus) || null;
    this.retryable = !!(options && options.retryable);
  }
}

function baseUrl() {
  return String(process.env.NIRO_AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function apiKey() {
  return String(process.env.NIRO_AI_API_KEY || '').trim();
}

/** Sin key configurada la IA queda apagada en todo el sistema, sin romper nada. */
function isConfigured() {
  return apiKey().length > 0;
}

function timeoutMs() {
  const value = Number(process.env.NIRO_AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

// Traduce los códigos de la API (401 key inválida, 402 sin saldo, 502 proveedor caído,
// 503 sin modelo habilitado) a mensajes que un agente humano pueda entender en pantalla.
function describeUpstreamError(status, payload) {
  const detail = payload && payload.error && payload.error.message ? String(payload.error.message) : null;
  if (status === 401) return detail || 'La API key de Niro IA es inválida o fue revocada';
  if (status === 402) return detail || 'La organización se quedó sin créditos de IA en Niro';
  if (status === 404) return detail || 'El recurso de IA no existe o no pertenece a esta organización';
  if (status === 400) return detail || 'La solicitud a Niro IA es inválida';
  if (status === 502) return detail || 'El proveedor de IA devolvió un error, probá de nuevo en unos segundos';
  if (status === 503) return detail || 'No hay ningún modelo de IA habilitado para esa categoría';
  return detail || `Niro IA respondió con el código ${status}`;
}

async function request(pathname, { method = 'POST', json, form, timeout } = {}) {
  if (!isConfigured()) {
    throw new NiroAiError('Falta configurar NIRO_AI_API_KEY en el servidor', 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || timeoutMs());
  const headers = { Authorization: `Bearer ${apiKey()}` };
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }

  let response;
  try {
    response = await fetch(`${baseUrl()}${pathname}`, { method, headers, body, signal: controller.signal });
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    throw new NiroAiError(
      aborted ? 'Niro IA tardó demasiado en responder' : 'No se pudo conectar con Niro IA',
      504,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new NiroAiError(describeUpstreamError(response.status, payload), response.status === 402 ? 402 : 502, {
      upstreamStatus: response.status,
      retryable: response.status === 502 || response.status === 503
    });
  }

  return payload || {};
}

function buildFile(buffer, fileName, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName || 'archivo');
  return form;
}

/** Chat multimodelo con formato OpenAI. `messages`: [{ role, content }]. */
async function chatCompletion(messages, options = {}) {
  const payload = await request('/api/v1/chat/completions', {
    json: { messages },
    timeout: options.timeout
  });
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
  return { content, usage: payload.usage || null, cost: payload.cost ?? null, raw: payload };
}

/** Transcribe un audio (mp3, ogg, m4a, wav...). Devuelve el texto completo. */
async function transcribeAudio(buffer, fileName, mimeType, options = {}) {
  const payload = await request('/api/v1/audio/transcriptions', {
    form: buildFile(buffer, fileName, mimeType),
    timeout: options.timeout
  });
  return {
    text: typeof payload.text === 'string' ? payload.text.trim() : '',
    seconds: payload.seconds ?? null,
    cost: payload.cost ?? null
  };
}

/**
 * OCR con visión. mode 'text' transcribe todo; mode 'invoice' devuelve la factura paraguaya
 * como JSON (emisor, RUC, timbrado, ítems, IVA 5/10, total).
 */
async function visionExtract(buffer, fileName, mimeType, options = {}) {
  const form = buildFile(buffer, fileName, mimeType);
  form.append('mode', options.mode === 'invoice' ? 'invoice' : 'text');
  if (options.question) form.append('question', String(options.question));
  const payload = await request('/api/v1/vision/extract', { form, timeout: options.timeout });
  return {
    text: typeof payload.text === 'string' ? payload.text.trim() : '',
    data: payload.data || null,
    cost: payload.cost ?? null
  };
}

/** Pregunta sobre un PDF con texto seleccionable. */
async function analyzeDocument(buffer, fileName, mimeType, options = {}) {
  const form = buildFile(buffer, fileName, mimeType);
  if (options.question) form.append('question', String(options.question));
  const payload = await request('/api/v1/documents/analyze', { form, timeout: options.timeout });
  return {
    answer: typeof payload.answer === 'string' ? payload.answer.trim() : '',
    extractedChars: payload.extractedChars ?? null,
    cost: payload.cost ?? null
  };
}

/** Agentes propios de la organización dueña de la API key. */
async function listAgents() {
  const payload = await request('/api/v1/agents', { method: 'GET' });
  return Array.isArray(payload.agents) ? payload.agents : [];
}

async function createAgent({ name, systemPrompt, description, category }) {
  const payload = await request('/api/v1/agents', {
    json: { name, systemPrompt, description: description || undefined, category: category || 'CHAT' }
  });
  return payload.agent || payload;
}

async function chatWithAgent(agentId, messages, options = {}) {
  const payload = await request(`/api/v1/agents/${encodeURIComponent(agentId)}/chat`, {
    json: { messages },
    timeout: options.timeout
  });
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content =
    (choice && choice.message && typeof choice.message.content === 'string' && choice.message.content) ||
    (typeof payload.reply === 'string' && payload.reply) ||
    (typeof payload.content === 'string' && payload.content) ||
    '';
  return { content: content.trim(), cost: payload.cost ?? null, raw: payload };
}

module.exports = {
  NiroAiError,
  isConfigured,
  baseUrl,
  chatCompletion,
  transcribeAudio,
  visionExtract,
  analyzeDocument,
  listAgents,
  createAgent,
  chatWithAgent
};
