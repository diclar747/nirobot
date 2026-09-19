const { HttpError } = require('./errors');

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1/audio/speech';
const DEFAULT_TIMEOUT_MS = 90000;

function provider() {
  return String(process.env.CALL_TTS_PROVIDER || '').trim().toLowerCase();
}

function timeoutMs() {
  const value = Number(process.env.CALL_TTS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function status() {
  const selected = provider();
  if (selected === 'openai') {
    const configured = Boolean(String(process.env.OPENAI_API_KEY || '').trim());
    return {
      configured,
      provider: selected,
      label: 'OpenAI voz',
      voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'],
      reason: configured ? null : 'Falta configurar OPENAI_API_KEY en el servidor.'
    };
  }
  if (selected === 'niro') {
    const hasKey = Boolean(String(process.env.NIRO_AI_API_KEY || '').trim());
    const hasPath = Boolean(String(process.env.NIRO_AI_TTS_PATH || '').trim());
    return {
      configured: hasKey && hasPath,
      provider: selected,
      label: 'Niro IA voz',
      voices: [],
      reason: !hasKey ? 'Falta configurar NIRO_AI_API_KEY en el servidor.' : !hasPath ? 'Niro IA no publica un endpoint TTS documentado; configurá NIRO_AI_TTS_PATH cuando tu cuenta lo tenga habilitado.' : null
    };
  }
  return {
    configured: false,
    provider: selected || null,
    label: 'Generación de voz no configurada',
    voices: [],
    reason: 'Configurá CALL_TTS_PROVIDER=openai con OPENAI_API_KEY o CALL_TTS_PROVIDER=niro con NIRO_AI_TTS_PATH.'
  };
}

function safeText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new HttpError(400, 'Escribí el texto que querés convertir en audio');
  if (text.length > 5000) throw new HttpError(400, 'El texto no puede superar los 5.000 caracteres');
  return text;
}

function normalizeSpeed(value) {
  const speed = Number(value || 1);
  if (!Number.isFinite(speed)) return 1;
  return Math.min(1.5, Math.max(0.25, speed));
}

async function requestBinary(url, { headers, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new HttpError(504, 'El proveedor de voz tardó demasiado en responder');
    throw new HttpError(502, 'No se pudo conectar con el proveedor de voz');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let message = detail;
    try {
      const payload = JSON.parse(detail);
      message = payload?.error?.message || payload?.error || detail;
    } catch {
      // Some providers return a plain-text error.
    }
    throw new HttpError(502, `El proveedor de voz rechazó la solicitud${message ? `: ${String(message).slice(0, 240)}` : ''}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new HttpError(502, 'El proveedor de voz devolvió un audio vacío');
  return { buffer, mimeType: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg' };
}

async function synthesize({ text, voice, language, speed }) {
  const input = safeText(text);
  const selected = provider();
  const config = status();
  if (!config.configured) throw new HttpError(503, config.reason);

  if (selected === 'openai') {
    const selectedVoice = String(voice || process.env.OPENAI_TTS_VOICE || 'alloy');
    const result = await requestBinary(process.env.OPENAI_TTS_URL || DEFAULT_OPENAI_URL, {
      headers: { Authorization: `Bearer ${String(process.env.OPENAI_API_KEY).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        input,
        voice: selectedVoice,
        response_format: 'mp3',
        speed: normalizeSpeed(speed),
        ...(language ? { instructions: `Hablá en ${String(language).slice(0, 40)}.` } : {})
      })
    });
    return { ...result, provider: selected, voice: selectedVoice };
  }

  if (selected === 'niro') {
    const base = String(process.env.NIRO_AI_BASE_URL || 'https://niro.cnid.com.py').replace(/\/+$/, '');
    const selectedVoice = String(voice || process.env.NIRO_AI_TTS_VOICE || '') || null;
    const result = await requestBinary(`${base}${process.env.NIRO_AI_TTS_PATH}`, {
      headers: { Authorization: `Bearer ${String(process.env.NIRO_AI_API_KEY).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.NIRO_AI_TTS_MODEL || undefined,
        input,
        text: input,
        voice: selectedVoice || undefined,
        language: language || process.env.NIRO_AI_TTS_LANGUAGE || 'es-PY',
        response_format: 'mp3',
        speed: normalizeSpeed(speed)
      })
    });
    return { ...result, provider: selected, voice: selectedVoice };
  }

  throw new HttpError(503, 'No hay un proveedor de voz configurado');
}

module.exports = { provider, status, synthesize };
