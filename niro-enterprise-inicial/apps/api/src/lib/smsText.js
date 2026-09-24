// Reglas puras de SMS (sin base de datos): números de Paraguay, largo/codificación del texto y lectura de listas.
// El front replica estas mismas reglas para mostrar el contador; el servidor siempre las vuelve a validar.
const { personalizeCampaignMessage } = require('./campaignVariables');

const GSM_LIMIT = 160;
const UCS2_LIMIT = 70;
const GSM_EXTENDED = new Set(['^', '{', '}', '\\', '[', ']', '~', '|']); // cuentan doble en GSM-7

// Celulares de Paraguay: 595 + 9XX + 6 dígitos (12 dígitos en total).
// 0985768793 -> 595985768793 · 985768793 -> 595985768793 · +595 985 768 793 -> 595985768793
function normalizePyPhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('5950')) digits = `595${digits.slice(4)}`; // 5950985… (con el 0 de más)
  if (digits.startsWith('595')) { /* ya tiene el código de país */ }
  else if (digits.startsWith('0')) digits = `595${digits.slice(1)}`;
  else if (digits.length === 9) digits = `595${digits}`;
  return /^5959\d{8}$/.test(digits) ? digits : null;
}

const CHAR_MAP = { '¿': '?', '¡': '!', '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '´': "'", '`': "'", '–': '-', '—': '-', '…': '...', '€': 'EUR', '°': 'o', 'º': 'o', 'ª': 'a', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'œ': 'oe', 'Œ': 'OE', '\t': ' ' };

// Pasa el texto a ASCII: quita tildes y la ñ (á->a, ñ->n), cambia signos especiales y descarta emojis.
function stripToAscii(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E\n]/g, (ch) => (ch in CHAR_MAP ? CHAR_MAP[ch] : ''))
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Largo, codificación y si entra en UN solo SMS. Con caracteres fuera de ASCII (tildes, ñ, emojis) el proveedor usa
// UCS-2 y el límite baja a 70; por eso "quitar tildes" viene activado por defecto y da el límite de 160.
function analyzeText(text, { stripAccents = true } = {}) {
  let value = String(text ?? '').replace(/\r\n/g, '\n');
  if (stripAccents) value = stripToAscii(value);
  const ascii = /^[\x20-\x7E\n]*$/.test(value);
  const length = ascii ? [...value].reduce((total, ch) => total + (GSM_EXTENDED.has(ch) ? 2 : 1), 0) : value.length;
  const limit = ascii ? GSM_LIMIT : UCS2_LIMIT;
  return { text: value, encoding: ascii ? 'gsm7' : 'ucs2', length, limit, segments: length <= limit ? 1 : Math.ceil(length / (ascii ? 153 : 67)), fits: length > 0 && length <= limit };
}

function renderMessage(template, recipient, options) {
  const personalized = personalizeCampaignMessage(String(template || ''), { name: recipient?.name || '', phone: recipient?.phone || '', email: '' });
  return analyzeText(personalized, options);
}

// Lee una lista pegada o subida (.txt/.csv): una persona por línea, "nombre,número" o "número,nombre" o solo "número".
// Separadores: coma, punto y coma, tabulación o espacios. La primera línea de títulos ("nombre,numero") se ignora.
// allowInternational (WhatsApp): si no es un celular de Paraguay, acepta también un número internacional completo
// (11 a 15 dígitos con código de país, ej. 5491155554444).
function internationalPhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return /^[1-9]\d{10,14}$/.test(digits) && !digits.startsWith('595') ? digits : null;
}

function parseRecipientList(text, { max = 20000, allowInternational = false } = {}) {
  const rows = [];
  const seen = new Set();
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    if (rows.length >= max) break;
    const match = /\+?\d[\d\s().-]{5,}\d/.exec(line);
    if (!match) {
      if (index === 0) continue; // encabezado
      rows.push({ line: index + 1, raw: line, name: null, phone: null, valid: false, reason: 'No tiene un número de teléfono' });
      continue;
    }
    const name = (line.slice(0, match.index) + ' ' + line.slice(match.index + match[0].length))
      .replace(/["';,\t|]+/g, ' ').replace(/\s{2,}/g, ' ').trim() || null;
    const phone = normalizePyPhone(match[0]) || (allowInternational ? internationalPhone(match[0]) : null);
    if (!phone) rows.push({ line: index + 1, raw: line, name, phone: null, valid: false, reason: allowInternational ? 'Número no válido (ej. 0985 768 793 o con código de país)' : 'Número no válido (celular de Paraguay: 09XX XXX XXX)' });
    else if (seen.has(phone)) rows.push({ line: index + 1, raw: line, name, phone, valid: false, reason: 'Número repetido' });
    else { seen.add(phone); rows.push({ line: index + 1, raw: line, name, phone, valid: true, reason: null }); }
  }
  return rows;
}

module.exports = { GSM_LIMIT, UCS2_LIMIT, normalizePyPhone, internationalPhone, stripToAscii, analyzeText, renderMessage, parseRecipientList };
