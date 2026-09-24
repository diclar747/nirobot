// Variables de personalización de mensajes de campaña. Una sola fuente de verdad: el servidor
// las usa para enviar y validar; el front replica la misma lógica para la vista previa.
//
// Sintaxis: {{nombre}}  ·  con valor de respaldo si falta el dato: {{nombre|amigo}}, {{email|sin email}}

const TOKEN = /\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

const VARIABLE_KEYS = ['nombre', 'name', 'nombre_completo', 'nombre completo', 'telefono', 'teléfono', 'phone', 'email'];
const PUBLIC_VARIABLES = ['{{nombre}}', '{{nombre_completo}}', '{{telefono}}', '{{email}}'];

// Aceptamos también {nombre} (llaves simples), que es como lo escribe mucha gente; solo para variables conocidas.
const SINGLE_BRACE = new RegExp('(?<!\\{)\\{\\s*(' + ['nombre_completo', 'nombre completo', 'nombre', 'name', 'telefono', 'teléfono', 'phone', 'email'].join('|') + ')\\s*(\\|[^{}]*)?\\}(?!\\})', 'gi');
function normalizeBraces(template) {
  return String(template || '').replace(SINGLE_BRACE, (_m, key, fallback) => `{{${key}${fallback || ''}}}`);
}

// Un contacto guardado solo con su número (sin nombre real) no tiene nombre para saludar.
function realName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return /[\p{L}]/u.test(name) ? name : '';
}

function valueFor(key, contact) {
  const fullName = realName(contact && contact.name);
  const phone = contact && contact.phone ? String(contact.phone).trim() : '';
  const email = contact && contact.email ? String(contact.email).trim() : '';
  switch (key) {
    case 'nombre':
    case 'name':
      return fullName.split(/\s+/)[0] || '';
    case 'nombre_completo':
    case 'nombre completo':
      return fullName;
    case 'telefono':
    case 'teléfono':
    case 'phone':
      return phone;
    case 'email':
      return email;
    default:
      return null;
  }
}

function personalizeCampaignMessage(template, contact) {
  return normalizeBraces(template)
    .replace(TOKEN, (match, rawKey, fallback) => {
      const key = String(rawKey).trim().toLowerCase();
      const value = valueFor(key, contact);
      if (value === null) return match; // desconocida: la validación de creación ya la rechaza
      if (value) return value;
      if (fallback) return fallback;
      // Sin dato y sin respaldo: el nombre cae a "cliente"; el resto queda vacío (nunca "—").
      return key === 'nombre' || key === 'name' || key === 'nombre_completo' || key === 'nombre completo' ? 'cliente' : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1');
}

function findUnknownVariables(template) {
  const unknown = new Set();
  for (const match of normalizeBraces(template).matchAll(TOKEN)) {
    if (!VARIABLE_KEYS.includes(String(match[1]).trim().toLowerCase())) unknown.add(`{{${String(match[1]).trim()}}}`);
  }
  return [...unknown];
}

module.exports = { personalizeCampaignMessage, findUnknownVariables, realName, PUBLIC_VARIABLES, VARIABLE_KEYS };
