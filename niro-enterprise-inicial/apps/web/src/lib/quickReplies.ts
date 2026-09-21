export interface QuickReply {
  id: string; shortcut: string; title: string; content: string; shared: boolean; mine: boolean;
  usageCount: number; lastUsedAt: string | null; createdBy: { id: string; name: string } | null;
}

export interface TemplateContext { name?: string | null; phone?: string | null; email?: string | null; agent?: string | null; company?: string | null }

export const QUICK_VARIABLES = [
  { token: '{{nombre}}', label: 'Nombre del cliente' },
  { token: '{{nombre_completo}}', label: 'Nombre completo' },
  { token: '{{telefono}}', label: 'Teléfono' },
  { token: '{{email}}', label: 'Email' },
  { token: '{{agente}}', label: 'Tu nombre' },
  { token: '{{empresa}}', label: 'Tu empresa' }
];

const TOKEN = /\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/** Reemplaza las variables con los datos del cliente y del agente. {{nombre|amigo}} usa "amigo" si falta el dato. */
export function fillTemplate(template: string, ctx: TemplateContext): string {
  const full = ctx.name?.trim() || '';
  const values: Record<string, string> = {
    nombre: full.split(/\s+/)[0] || '', name: full.split(/\s+/)[0] || '',
    nombre_completo: full, telefono: ctx.phone || '', 'teléfono': ctx.phone || '', email: ctx.email || '',
    agente: ctx.agent?.trim() || '', empresa: ctx.company?.trim() || ''
  };
  return template
    .replace(TOKEN, (match, rawKey: string, fallback?: string) => {
      const key = rawKey.trim().toLowerCase();
      if (!(key in values)) return match;
      if (values[key]) return values[key];
      if (fallback) return fallback;
      return key === 'nombre' || key === 'nombre_completo' ? 'cliente' : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1');
}

/** Detecta si el cursor está justo después de "/algo" (inicio de línea o tras un espacio). */
export function detectSlash(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s])\/([^\s/]*)$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2].toLowerCase() };
}

export function rankReplies(list: QuickReply[], query: string): QuickReply[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const score = (r: QuickReply) => {
    const s = r.shortcut.toLowerCase();
    if (s === q) return 0;
    if (s.startsWith(q)) return 1;
    if (s.includes(q)) return 2;
    if (r.title.toLowerCase().includes(q)) return 3;
    if (r.content.toLowerCase().includes(q)) return 4;
    return 99;
  };
  return list.filter((r) => score(r) < 99).sort((a, b) => score(a) - score(b) || b.usageCount - a.usageCount);
}
