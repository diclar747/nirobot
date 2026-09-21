// Permisos por usuario. Propietario y administrador SIEMPRE tienen todo.
// Supervisores y agentes empiezan con todo activo; el admin puede apagar funciones una por una.
// Se guarda solo lo que el admin cambió (permissions = { campaigns: false, ... }).

const PERMISSIONS = [
  { key: 'campaigns',      group: 'Envíos',     label: 'Campañas de WhatsApp',      description: 'Crear, iniciar y ver campañas masivas y a grupos.' },
  { key: 'statuses',       group: 'Envíos',     label: 'Estados de WhatsApp',       description: 'Publicar y programar estados.' },
  { key: 'calls',          group: 'Envíos',     label: 'Llamadas',                  description: 'Campañas de llamadas y audios.' },
  { key: 'contacts',       group: 'Contactos',  label: 'Contactos',                 description: 'Ver el directorio de contactos y sincronizar el teléfono.' },
  { key: 'contactsExport', group: 'Contactos',  label: 'Descargar contactos',       description: 'Exportar todos los contactos a CSV.' },
  { key: 'contactsDelete', group: 'Contactos',  label: 'Eliminar contactos',        description: 'Borrar contactos y sus conversaciones.' },
  { key: 'crm',            group: 'Ventas',     label: 'CRM',                       description: 'Tablero CRM y enviar contactos a una etapa.' },
  { key: 'orders',         group: 'Ventas',     label: 'Pedidos',                   description: 'Ver y gestionar pedidos.' },
  { key: 'transferChats',  group: 'Atención',   label: 'Transferir chats',          description: 'Pasar conversaciones a otro agente o departamento.' },
  { key: 'reports',        group: 'Gestión',    label: 'Reportes',                  description: 'Ver reportes y métricas.' },
  { key: 'bot',            group: 'Automatización', label: 'Bot de flujos',         description: 'Ver y editar el flujo del bot.' },
  { key: 'aiAgents',       group: 'Automatización', label: 'Agentes de IA',         description: 'Configurar y probar agentes de IA.' },
  { key: 'developers',     group: 'Automatización', label: 'API y desarrolladores', description: 'Portal de API y webhooks.' }
];

const KEYS = PERMISSIONS.map((p) => p.key);
const ALWAYS_FULL = ['SUPERADMIN', 'OWNER', 'ADMIN'];

function isRestrictable(role) { return !ALWAYS_FULL.includes(role); }

// Mapa completo { key: boolean } de lo que el usuario puede hacer.
function effectivePermissions(user) {
  const map = {};
  const stored = user && user.permissions && typeof user.permissions === 'object' ? user.permissions : {};
  const full = !user || !isRestrictable(user.role);
  for (const key of KEYS) map[key] = full ? true : stored[key] !== false;
  return map;
}

// Valida lo que envía el admin y devuelve solo claves conocidas con booleanos.
function normalizePermissionsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const key of KEYS) if (typeof input[key] === 'boolean') out[key] = input[key];
  return out;
}

function requirePermission(key) {
  const { HttpError } = require('./errors');
  return (req, _res, next) => {
    if (!req.auth) return next(new HttpError(401, 'No autenticado'));
    if (req.auth.permissions && req.auth.permissions[key] === false) {
      return next(new HttpError(403, 'Tu administrador no habilitó esta función para tu usuario'));
    }
    next();
  };
}

module.exports = { PERMISSIONS, KEYS, effectivePermissions, normalizePermissionsInput, requirePermission, isRestrictable };
