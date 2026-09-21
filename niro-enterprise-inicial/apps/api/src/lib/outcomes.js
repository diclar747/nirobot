// Gestión de cada conversación: cómo terminó (venta cerrada, venta perdida, cotización enviada…) y por cuánto.
// Cada empresa define sus categorías; al cerrar un chat el agente elige una y, si es una venta, carga el monto.
const { prisma } = require('./prisma');
const { HttpError } = require('./errors');

const KINDS = ['WON', 'LOST', 'QUOTE', 'OTHER'];
const KIND_LABEL = { WON: 'Venta', LOST: 'Perdida', QUOTE: 'Cotización', OTHER: 'Otra gestión' };
const STAGE_TAGS = ['Abiertas', 'Pendientes', 'Clientes', 'Interesados', 'Cerradas'];
const MAX_AMOUNT = 999999999999;

const DEFAULT_CATEGORIES = [
  { name: 'Venta cerrada', kind: 'WON', requiresAmount: true, color: '#10b981' },
  { name: 'Venta perdida', kind: 'LOST', requiresAmount: false, color: '#ef4444' },
  { name: 'Cotización enviada', kind: 'QUOTE', requiresAmount: false, color: '#0284c7' },
  { name: 'Cotización entregada', kind: 'QUOTE', requiresAmount: false, color: '#8b5cf6' }
];

// Una empresa sin categorías recibe las cuatro de siempre; después las edita, agrega o desactiva a gusto.
async function ensureDefaultCategories(organizationId) {
  const total = await prisma.outcomeCategory.count({ where: { organizationId } });
  if (total > 0) return;
  await prisma.outcomeCategory.createMany({
    data: DEFAULT_CATEGORIES.map((category, index) => ({ organizationId, sortOrder: index, ...category })),
    skipDuplicates: true
  });
}

async function hasActiveCategories(organizationId) {
  await ensureDefaultCategories(organizationId);
  return (await prisma.outcomeCategory.count({ where: { organizationId, active: true } })) > 0;
}

function parseAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  let text = typeof value === 'number' ? value : String(value).trim().replace(/\s/g, '');
  // Formatos aceptados: "2500000", "2500000.50", "2.500.000" (puntos de miles) y "2.500.000,50" (coma decimal).
  if (typeof text === 'string') {
    if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_AMOUNT) throw new HttpError(400, 'El monto no es válido');
  return Math.round(number * 100) / 100;
}

// Registra la gestión dentro de una transacción. Si `close`, deja la conversación cerrada en la etapa "Cerradas".
async function createOutcome(tx, { organizationId, conversation, actor, categoryId, amount, note, close = false, status = 'CLOSED' }) {
  const category = categoryId ? await tx.outcomeCategory.findFirst({ where: { id: categoryId, organizationId, active: true } }) : null;
  if (!category) throw new HttpError(400, 'Elegí una categoría válida');
  const parsedAmount = parseAmount(amount);
  if ((category.requiresAmount || category.kind === 'WON') && !parsedAmount) throw new HttpError(400, 'Ingresá el monto de la venta');
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null;

  const outcome = await tx.conversationOutcome.create({
    data: {
      organizationId,
      conversationId: conversation.id,
      contactId: conversation.contactId || null,
      agentId: actor.id,
      agentName: actor.name || 'Agente',
      categoryId: category.id,
      categoryName: category.name,
      kind: category.kind,
      amount: parsedAmount,
      note: cleanNote,
      closedConversation: Boolean(close)
    }
  });
  let updated = null;
  if (close) {
    const tags = [...(conversation.tags || []).filter((tag) => !STAGE_TAGS.includes(tag)), 'Cerradas'];
    updated = await tx.conversation.update({ where: { id: conversation.id }, data: { status: ['RESOLVED', 'CLOSED'].includes(status) ? status : 'CLOSED', tags } });
  }
  return { outcome, conversation: updated };
}

// Deja la gestión escrita en el chat como nota interna, igual que las transferencias: queda en el historial de la conversación.
async function postOutcomeNote({ organizationId, conversationId, outcome, userId }) {
  const { MESSAGE_INCLUDE, broadcastMessage } = require('./conversations');
  const amount = outcome.amount === null || outcome.amount === undefined ? '' : ` · Gs. ${Math.round(Number(outcome.amount)).toLocaleString('es-PY')}`;
  const content = `📌 [GESTIÓN]: ${outcome.agentName} registró «${outcome.categoryName}»${amount}${outcome.closedConversation ? ' y cerró la conversación' : ''}.${outcome.note ? `\nNota: ${outcome.note}` : ''}`;
  const message = await prisma.message.create({ data: { conversationId, senderUserId: userId, direction: 'NOTE', content }, include: MESSAGE_INCLUDE });
  broadcastMessage(organizationId, conversationId, message);
}

function sanitizeOutcome(row) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    contact: row.contact ? { id: row.contact.id, name: row.contact.name, phone: row.contact.phone } : null,
    agentId: row.agentId,
    agentName: row.agentName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    kind: row.kind,
    color: row.category?.color || null,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    note: row.note,
    closedConversation: row.closedConversation,
    createdAt: row.createdAt
  };
}

module.exports = { postOutcomeNote, KINDS, KIND_LABEL, DEFAULT_CATEGORIES, ensureDefaultCategories, hasActiveCategories, createOutcome, sanitizeOutcome, parseAmount };
