// Texto de los chats como en WhatsApp: links clicables y formato *negrita*, _cursiva_, ~tachado~, `código` y bloques ```código```.
// Los saltos de línea los conserva el CSS (white-space: pre-wrap); acá solo se separan los pedazos. Nada de HTML crudo:
// todo sale como nodos de React, así un mensaje nunca puede inyectar código.
export type RichNode =
  | { type: 'text'; text: string }
  | { type: 'bold' | 'italic' | 'strike'; children: RichNode[] }
  | { type: 'code'; text: string }
  | { type: 'pre'; text: string }
  | { type: 'link'; text: string; href: string; kind: LinkKind };

// Qué es cada enlace: se le pone un ícono distinto en el chat (web, correo, teléfono).
export type LinkKind = 'url' | 'email' | 'phone';

const TLDS = 'com\\.py|com\\.ar|com\\.br|com|py|net|org|io|app|co|ar|br|es|info|online|store|site|xyz|dev|me|tv|cl|uy|bo|pe|us|shop|tech|ai';
// email | http(s):// o www. | dominio suelto (niro.com.py). Antes del dominio suelto no puede haber letras, @ ni / (evita partir palabras).
const LINK_RE = new RegExp(
  `(?<![\\w.+-])[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+` +
  `|(?:https?:\\/\\/|www\\.)[^\\s<>"'\`]+` +
  `|(?<![\\w@/.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![\\w-])(?::\\d{2,5})?(?:\\/[^\\s<>"'\`]*)?` +
  `|(?<![\\w.,/@+-])(?:\\(\\d|\\+?\\d)(?:[\\d ()-]*\\d)?`,
  'gi'
);

// Un número de teléfono: 9 a 13 dígitos y aspecto de teléfono (empieza con + o 0, es 595…, o viene con espacios/guiones).
// Así "1500000" o "12500000 Gs" no se toman por teléfono, ni las fechas 2026-09-21.
function phoneDigits(value: string) {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 13) return null;
  const looksLikePhone = value.startsWith('+') || digits.startsWith('0') || digits.startsWith('595') || /[ ()-]/.test(value);
  return looksLikePhone ? (value.startsWith('+') ? `+${digits}` : digits) : null;
}

// Signos que pueden pegarse al final de un link sin ser parte de él.
function trimLink(raw: string) {
  let value = raw;
  let tail = '';
  for (;;) {
    const last = value[value.length - 1];
    if (!last) break;
    const unbalanced = last === ')' && (value.match(/\(/g) || []).length < (value.match(/\)/g) || []).length;
    if (/[.,;:!?'"»\]}]/.test(last) || unbalanced) { tail = last + tail; value = value.slice(0, -1); } else break;
  }
  return { value, tail };
}

export function hrefFor(value: string) {
  if (/^[\w.+-]+@/.test(value) && !/^https?:/i.test(value)) return `mailto:${value}`;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function linkify(text: string): RichNode[] {
  const out: RichNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_RE)) {
    const start = match.index ?? 0;
    const isPhone = /^[+(\d]/.test(match[0]);
    if (isPhone) {
      const number = phoneDigits(match[0]);
      if (!number) continue;
      if (start > last) out.push({ type: 'text', text: text.slice(last, start) });
      out.push({ type: 'link', text: match[0], href: `tel:${number}`, kind: 'phone' });
      last = start + match[0].length;
      continue;
    }
    const { value, tail } = trimLink(match[0]);
    if (!value || value.length < 4) continue;
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) });
    out.push({ type: 'link', text: value, href: hrefFor(value), kind: hrefFor(value).startsWith('mailto:') ? 'email' : 'url' });
    last = start + value.length;
    if (tail) { /* el signo final queda como texto: se agrega con el resto */ }
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.length ? out : [{ type: 'text', text }];
}

// Formato de WhatsApp dentro de una línea: el marcador va pegado al texto (no a espacios) y el cierre antes de un espacio o signo.
const FORMAT_RE = /(^|[\s(\[{"'¡¿¡¿.,;:!?-])(\*|_|~|`)(?=\S)((?:(?!\2)[^\n])*?\S)\2(?=$|[\s)\]}"'.,;:!?-])/;
const KIND: Record<string, 'bold' | 'italic' | 'strike' | 'code'> = { '*': 'bold', '_': 'italic', '~': 'strike', '`': 'code' };

function inline(text: string, depth = 0): RichNode[] {
  if (!text) return [];
  const match = depth < 4 ? FORMAT_RE.exec(text) : null;
  if (!match) return linkify(text);
  const [full, lead, marker, inner] = match;
  const start = match.index + lead.length;
  const end = match.index + full.length;
  const kind = KIND[marker];
  // Un link con guiones bajos (foo_bar_baz.com) no debe convertirse en cursiva.
  if (kind === 'italic' && /(?:https?:\/\/|www\.)\S*$/i.test(text.slice(0, start))) return linkify(text);
  const nodes: RichNode[] = [];
  const before = text.slice(0, start);
  if (before) nodes.push(...inline(before, depth + 1));
  nodes.push(kind === 'code' ? { type: 'code', text: inner } : { type: kind, children: inline(inner, depth + 1) });
  const after = text.slice(end);
  if (after) nodes.push(...inline(after, depth + 1));
  return nodes;
}

export function tokenize(input: string): RichNode[] {
  const text = String(input ?? '').replace(/\r\n?/g, '\n');
  const out: RichNode[] = [];
  let last = 0;
  for (const block of text.matchAll(/```\n?([\s\S]*?)\n?```/g)) {
    const start = block.index ?? 0;
    if (start > last) out.push(...lines(text.slice(last, start)));
    out.push({ type: 'pre', text: block[1] });
    last = start + block[0].length;
  }
  if (last < text.length) out.push(...lines(text.slice(last)));
  return out;
}

// El formato no cruza saltos de línea: se procesa línea por línea y los "\n" se conservan.
function lines(text: string): RichNode[] {
  const out: RichNode[] = [];
  text.split('\n').forEach((line, index, all) => {
    out.push(...inline(line));
    if (index < all.length - 1) out.push({ type: 'text', text: '\n' });
  });
  return out;
}
