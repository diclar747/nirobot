// SMS prepago: saldo por empresa (1 crédito = 1 SMS), campañas, motor de envío y recargas.
const { prisma } = require('./prisma');
const { HttpError } = require('./errors');
const { emitToOrg } = require('./realtime');
const provider = require('./smsProvider');
const text = require('./smsText');

const PRICE_GS = () => Math.max(1, Number(process.env.SMS_PRICE_GS) || 130);
const PACKAGES = [1000, 2500, 5000, 10000];
const MIN_PURCHASE = 100;
const MAX_PURCHASE = 1000000;
const MAX_RECIPIENTS = 20000;
const SEND_DELAY_MS = Number(process.env.SMS_SEND_DELAY_MS ?? 300);
const HOUR = 3600 * 1000;

function coded(status, message, code, extra = {}) {
  return Object.assign(new HttpError(status, message), { code, ...(Object.keys(extra).length ? { data: extra } : {}) });
}

// ---------------------------------------------------------------- saldo
// Toda variación del saldo pasa por acá y deja un movimiento. Una resta nunca deja el saldo en negativo.
async function changeBalance(organizationId, delta, { type, note = null, reference = null, userId = null }) {
  if (!Number.isInteger(delta) || delta === 0) throw new HttpError(400, 'La cantidad de SMS no es válida');
  return prisma.$transaction(async (tx) => {
    if (delta < 0) {
      const res = await tx.organization.updateMany({ where: { id: organizationId, smsBalance: { gte: -delta } }, data: { smsBalance: { decrement: -delta } } });
      if (res.count === 0) throw coded(402, 'No tenés saldo de SMS suficiente', 'SMS_INSUFFICIENT_BALANCE');
    } else {
      await tx.organization.update({ where: { id: organizationId }, data: { smsBalance: { increment: delta } } });
    }
    const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { smsBalance: true } });
    await tx.smsTransaction.create({ data: { organizationId, type, amount: delta, balanceAfter: org.smsBalance, note, reference, createdByUserId: userId } });
    return org.smsBalance;
  });
}

async function getBalance(organizationId) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { smsBalance: true } });
  return org ? org.smsBalance : 0;
}

// ---------------------------------------------------------------- campañas
function countsOf(groups) {
  const c = { total: 0, pending: 0, sending: 0, sent: 0, delivered: 0, failed: 0, cancelled: 0 };
  for (const g of groups) {
    const n = g._count._all ?? g._count;
    c.total += n;
    const key = { PENDING: 'pending', SENDING: 'sending', SENT: 'sent', DELIVERED: 'delivered', FAILED: 'failed', CANCELLED: 'cancelled' }[g.status];
    if (key) c[key] += n;
  }
  c.ok = c.sent + c.delivered; // enviados con éxito (incluye los confirmados como entregados)
  return c;
}

async function getCounts(campaignId) {
  return countsOf(await prisma.smsMessage.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } }));
}

function sanitizeCampaign(campaign, counts = null) {
  return {
    id: campaign.id, name: campaign.name, message: campaign.message, stripAccents: campaign.stripAccents, source: campaign.source,
    status: campaign.status, pauseReason: campaign.pauseReason, scheduledAt: campaign.scheduledAt, startedAt: campaign.startedAt,
    completedAt: campaign.completedAt, createdAt: campaign.createdAt, updatedAt: campaign.updatedAt, counts
  };
}

async function emitCampaign(organizationId, campaignId) {
  try {
    const [campaign, counts, balance] = await Promise.all([prisma.smsCampaign.findUnique({ where: { id: campaignId } }), getCounts(campaignId), getBalance(organizationId)]);
    if (campaign) emitToOrg(organizationId, 'sms:updated', { campaign: sanitizeCampaign(campaign, counts), balance });
  } catch { /* el tiempo real es un extra: nunca rompe el envío */ }
}

// Valida el mensaje contra cada destinatario (el nombre cambia el largo) y arma las filas a enviar.
function buildMessages(template, recipients, { stripAccents }) {
  const rows = [];
  const tooLong = [];
  for (const recipient of recipients) {
    const rendered = text.renderMessage(template, recipient, { stripAccents });
    if (!rendered.fits) { tooLong.push(recipient); continue; }
    rows.push({ contactId: recipient.contactId || null, name: recipient.name || null, phone: recipient.phone, body: rendered.text, encoding: rendered.encoding });
  }
  return { rows, tooLong };
}

// Une los destinatarios elegidos: contactos del CRM (por id o etiqueta) y números pegados/subidos. Sin repetidos ni inválidos.
async function resolveRecipients(organizationId, { contactIds = [], tagFilter = [], recipients = [], saveToCrm = false }) {
  const byPhone = new Map();
  const invalid = [];
  if (contactIds.length || tagFilter.length) {
    const contacts = await prisma.contact.findMany({
      where: { organizationId, phone: { not: null }, OR: [...(contactIds.length ? [{ id: { in: contactIds } }] : []), ...(tagFilter.length ? [{ tags: { hasSome: tagFilter } }] : [])] },
      select: { id: true, name: true, phone: true }
    });
    for (const contact of contacts) {
      const phone = text.normalizePyPhone(contact.phone);
      if (!phone) { invalid.push({ name: contact.name, phone: contact.phone }); continue; }
      if (!byPhone.has(phone)) byPhone.set(phone, { contactId: contact.id, name: contact.name, phone });
    }
  }
  for (const item of recipients) {
    const phone = text.normalizePyPhone(item.phone);
    if (!phone) { invalid.push({ name: item.name || null, phone: item.phone }); continue; }
    if (!byPhone.has(phone)) byPhone.set(phone, { contactId: null, name: item.name ? String(item.name).slice(0, 120) : null, phone });
  }
  if (saveToCrm) {
    for (const recipient of byPhone.values()) {
      if (recipient.contactId) continue;
      const existing = await prisma.contact.findFirst({ where: { organizationId, phone: recipient.phone }, select: { id: true, name: true } });
      if (existing) {
        recipient.contactId = existing.id;
        if (!existing.name && recipient.name) await prisma.contact.update({ where: { id: existing.id }, data: { name: recipient.name } });
      } else {
        const created = await prisma.contact.create({ data: { organizationId, phone: recipient.phone, name: recipient.name } });
        recipient.contactId = created.id;
      }
    }
  }
  return { recipients: [...byPhone.values()], invalid };
}

async function createCampaign(organizationId, userId, input) {
  const { name, message, stripAccents = true, source = 'CAMPAIGN', scheduledAt = null } = input;
  const base = text.analyzeText(String(message || ''), { stripAccents });
  if (!String(message || '').trim()) throw new HttpError(400, 'Escribí el mensaje');
  const { recipients, invalid } = await resolveRecipients(organizationId, input);
  if (recipients.length === 0) throw new HttpError(400, invalid.length ? `Ninguno de los ${invalid.length} números es un celular válido de Paraguay` : 'Elegí al menos un destinatario');
  if (recipients.length > MAX_RECIPIENTS) throw new HttpError(400, `Una campaña admite hasta ${MAX_RECIPIENTS.toLocaleString('es')} destinatarios`);
  const { rows, tooLong } = buildMessages(message, recipients, { stripAccents });
  if (tooLong.length > 0) {
    throw coded(400, tooLong.length === recipients.length
      ? `El mensaje supera el límite de ${base.limit} caracteres por SMS (tiene ${base.length}).`
      : `Con el nombre reemplazado, ${tooLong.length} SMS superan el límite de ${base.limit} caracteres. Acortá el mensaje.`, 'SMS_TOO_LONG');
  }
  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.smsCampaign.create({
      data: { organizationId, name: String(name).slice(0, 120), message: String(message), stripAccents, source, status: scheduledAt ? 'SCHEDULED' : 'DRAFT', scheduledAt: scheduledAt || null, createdByUserId: userId }
    });
    await tx.smsMessage.createMany({ data: rows.map((row) => ({ organizationId, campaignId: created.id, ...row })) });
    return created;
  });
  return { campaign, recipients: rows.length, invalid };
}

// Antes de salir se comprueba el saldo: si alcanzan menos SMS que destinatarios, no arranca y se avisa cuánto falta.
async function assertBalanceFor(organizationId, campaignId) {
  const pending = await prisma.smsMessage.count({ where: { campaignId, status: 'PENDING' } });
  const balance = await getBalance(organizationId);
  if (balance < pending) {
    throw coded(402, `No tenés saldo suficiente: necesitás ${pending.toLocaleString('es')} SMS y tenés ${balance.toLocaleString('es')}. Comprá ${(pending - balance).toLocaleString('es')} más para enviar esta campaña.`, 'SMS_INSUFFICIENT_BALANCE', { required: pending, balance, missing: pending - balance });
  }
  return { pending, balance };
}

async function startCampaign(organizationId, campaignId) {
  const campaign = await prisma.smsCampaign.findFirst({ where: { id: campaignId, organizationId } });
  if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
  if (!['DRAFT', 'SCHEDULED', 'PAUSED'].includes(campaign.status)) throw new HttpError(409, 'La campaña no está en un estado que se pueda iniciar');
  if (!provider.configured()) throw new HttpError(503, 'El envío de SMS todavía no está configurado');
  await assertBalanceFor(organizationId, campaign.id);
  const updated = await prisma.smsCampaign.update({ where: { id: campaign.id }, data: { status: 'SENDING', pauseReason: null, startedAt: campaign.startedAt || new Date(), scheduledAt: null } });
  runCampaign(campaign.id).catch((err) => console.error('[sms] runCampaign falló', err));
  return updated;
}

// Editar una campaña DETENIDA: cambia el texto solo de lo que todavía no salió; lo ya enviado no se toca.
async function updatePausedCampaign(organizationId, campaignId, { name, message, stripAccents = true }) {
  const campaign = await prisma.smsCampaign.findFirst({ where: { id: campaignId, organizationId } });
  if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
  if (campaign.status !== 'PAUSED') throw new HttpError(409, 'Detené la campaña antes de editarla');
  if (!String(message || '').trim()) throw new HttpError(400, 'Escribí el mensaje');
  const pending = await prisma.smsMessage.findMany({ where: { campaignId, status: 'PENDING' }, select: { id: true, name: true, phone: true } });
  const updates = [];
  let tooLong = 0;
  for (const row of pending) {
    const rendered = text.renderMessage(message, row, { stripAccents });
    if (!rendered.fits) { tooLong += 1; continue; }
    updates.push({ id: row.id, body: rendered.text, encoding: rendered.encoding });
  }
  if (tooLong > 0) throw coded(400, `Con el nombre reemplazado, ${tooLong} SMS pendientes superan el límite de 160 caracteres. Acortá el mensaje.`, 'SMS_TOO_LONG');
  for (let i = 0; i < updates.length; i += 500) {
    await prisma.$transaction(updates.slice(i, i + 500).map((u) => prisma.smsMessage.update({ where: { id: u.id }, data: { body: u.body, encoding: u.encoding } })));
  }
  return prisma.smsCampaign.update({ where: { id: campaignId }, data: { name: String(name || campaign.name).slice(0, 120), message: String(message), stripAccents } });
}

// Reenviar los que fallaron: vuelven a la cola y la campaña sigue enviando (se cobra de nuevo solo lo que salga).
async function retryFailed(organizationId, campaignId) {
  const campaign = await prisma.smsCampaign.findFirst({ where: { id: campaignId, organizationId } });
  if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
  if (campaign.status === 'SENDING') throw new HttpError(409, 'La campaña está enviando: detenela para reenviar los fallidos');
  if (campaign.status === 'DRAFT' || campaign.status === 'SCHEDULED') throw new HttpError(409, 'La campaña todavía no salió');
  if (!provider.configured()) throw new HttpError(503, 'El envío de SMS todavía no está configurado');
  const failed = await prisma.smsMessage.count({ where: { campaignId, status: 'FAILED' } });
  if (failed === 0) throw new HttpError(409, 'No hay SMS fallidos para reenviar');
  const pending = await prisma.smsMessage.count({ where: { campaignId, status: 'PENDING' } });
  const balance = await getBalance(organizationId);
  const required = failed + pending;
  if (balance < required) {
    throw coded(402, `No tenés saldo suficiente: necesitás ${required.toLocaleString('es')} SMS y tenés ${balance.toLocaleString('es')}.`, 'SMS_INSUFFICIENT_BALANCE', { required, balance, missing: required - balance, campaignId });
  }
  await prisma.$transaction([
    prisma.smsMessage.updateMany({ where: { campaignId, status: 'FAILED' }, data: { status: 'PENDING', errorMessage: null } }),
    prisma.smsCampaign.update({ where: { id: campaignId }, data: { status: 'SENDING', pauseReason: null, completedAt: null } })
  ]);
  runCampaign(campaignId).catch((err) => console.error('[sms] runCampaign falló', err));
  return prisma.smsCampaign.findUnique({ where: { id: campaignId } });
}

async function pauseCampaign(organizationId, campaignId) {
  const res = await prisma.smsCampaign.updateMany({ where: { id: campaignId, organizationId, status: 'SENDING' }, data: { status: 'PAUSED', pauseReason: 'Pausada por vos' } });
  if (res.count === 0) throw new HttpError(409, 'Solo se puede pausar una campaña que está enviando');
  return prisma.smsCampaign.findUnique({ where: { id: campaignId } });
}

async function cancelCampaign(organizationId, campaignId) {
  const campaign = await prisma.smsCampaign.findFirst({ where: { id: campaignId, organizationId } });
  if (!campaign) throw new HttpError(404, 'Campaña no encontrada');
  if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) throw new HttpError(409, 'La campaña ya terminó');
  // Lo que todavía no salió no se cobra (el saldo se descuenta al enviar cada SMS).
  await prisma.$transaction([
    prisma.smsMessage.updateMany({ where: { campaignId, status: 'PENDING' }, data: { status: 'CANCELLED' } }),
    prisma.smsCampaign.update({ where: { id: campaignId }, data: { status: 'CANCELLED', completedAt: new Date(), pauseReason: null } })
  ]);
  await emitCampaign(organizationId, campaignId);
  return prisma.smsCampaign.findUnique({ where: { id: campaignId } });
}

// ---------------------------------------------------------------- motor de envío
const running = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function refundIfCharged(organizationId, messageId, note) {
  const charged = await prisma.smsTransaction.findFirst({ where: { organizationId, reference: messageId, type: 'CONSUMPTION' } });
  const refunded = await prisma.smsTransaction.findFirst({ where: { organizationId, reference: messageId, type: 'REFUND' } });
  if (charged && !refunded) await changeBalance(organizationId, -charged.amount, { type: 'REFUND', reference: messageId, note });
}

async function pauseWithReason(organizationId, campaignId, reason) {
  await prisma.smsCampaign.updateMany({ where: { id: campaignId, status: 'SENDING' }, data: { status: 'PAUSED', pauseReason: reason } });
  await emitCampaign(organizationId, campaignId);
}

// Un SMS por vez, en orden. Descuenta 1 crédito justo antes de enviar y lo devuelve si el proveedor rechaza el mensaje.
async function runCampaign(campaignId) {
  if (running.has(campaignId)) return;
  running.add(campaignId);
  try {
    for (;;) {
      const campaign = await prisma.smsCampaign.findUnique({ where: { id: campaignId }, select: { id: true, organizationId: true, status: true } });
      if (!campaign || campaign.status !== 'SENDING') break;
      const { organizationId } = campaign;
      const next = await prisma.smsMessage.findFirst({ where: { campaignId, status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
      if (!next) {
        await prisma.smsCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED', completedAt: new Date() } });
        await emitCampaign(organizationId, campaignId);
        break;
      }
      const claimed = await prisma.smsMessage.updateMany({ where: { id: next.id, status: 'PENDING' }, data: { status: 'SENDING' } });
      if (claimed.count === 0) continue;

      try {
        await changeBalance(organizationId, -next.credits, { type: 'CONSUMPTION', reference: next.id, note: `SMS a ${next.phone}` });
      } catch (err) {
        await prisma.smsMessage.update({ where: { id: next.id }, data: { status: 'PENDING' } });
        if (err.code === 'SMS_INSUFFICIENT_BALANCE') {
          await pauseWithReason(organizationId, campaignId, 'Se terminó tu saldo de SMS. Comprá más y reanudá la campaña.');
          break;
        }
        throw err;
      }

      try {
        const result = await provider.sendSms({ to: next.phone, message: next.body });
        await prisma.smsMessage.update({ where: { id: next.id }, data: { status: 'SENT', sentAt: new Date(), providerMessageId: result.messageId, errorMessage: null } });
      } catch (err) {
        await refundIfCharged(organizationId, next.id, 'Devolución: el SMS no se pudo enviar').catch((e) => console.error('[sms] no se pudo devolver el crédito', e));
        if (err.outOfCredit) {
          // El proveedor no tiene saldo: no es culpa del mensaje, queda pendiente y se pausa.
          await prisma.smsMessage.update({ where: { id: next.id }, data: { status: 'PENDING' } });
          console.error('[sms] el proveedor (Winsap) no tiene saldo de SMS:', err.message);
          await pauseWithReason(organizationId, campaignId, 'El servicio de SMS está sin saldo en este momento. Ya avisamos al administrador; reanudá la campaña más tarde.');
          break;
        }
        await prisma.smsMessage.update({ where: { id: next.id }, data: { status: 'FAILED', errorMessage: String(err.message || 'Error al enviar').slice(0, 300) } });
      }
      await emitCampaign(organizationId, campaignId);
      if (SEND_DELAY_MS > 0) await sleep(SEND_DELAY_MS);
    }
  } finally {
    running.delete(campaignId);
  }
}

// Al arrancar: los SMS que quedaron "enviando" por un reinicio se marcan como fallidos y se devuelve el crédito si ya se
// había descontado (no se reintenta solo: podría haber salido y se duplicaría); y se retoman las campañas en curso.
async function resumeCampaigns() {
  const stuck = await prisma.smsMessage.findMany({ where: { status: 'SENDING' }, select: { id: true, organizationId: true } });
  for (const message of stuck) {
    await prisma.smsMessage.update({ where: { id: message.id }, data: { status: 'FAILED', errorMessage: 'Interrumpido por un reinicio del servidor; podés reenviarlo' } });
    await refundIfCharged(message.organizationId, message.id, 'Devolución: envío interrumpido por un reinicio').catch(() => {});
  }
  const sending = await prisma.smsCampaign.findMany({ where: { status: 'SENDING' }, select: { id: true } });
  for (const campaign of sending) runCampaign(campaign.id).catch((err) => console.error('[sms] no se pudo retomar la campaña', err));
}

// Cada tanto: arranca las campañas programadas que ya llegaron a su hora.
async function tick() {
  const due = await prisma.smsCampaign.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } }, select: { id: true, organizationId: true } });
  for (const campaign of due) {
    try { await startCampaign(campaign.organizationId, campaign.id); }
    catch (err) {
      await prisma.smsCampaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED', scheduledAt: null, pauseReason: `No pudo salir a la hora programada: ${err.message}` } }).catch(() => {});
      await emitCampaign(campaign.organizationId, campaign.id);
    }
  }
}

// ---------------------------------------------------------------- recargas
function packageAmount(credits) { return credits * PRICE_GS(); }

function validateCredits(value) {
  const credits = Number(value);
  if (!Number.isInteger(credits) || credits < MIN_PURCHASE || credits > MAX_PURCHASE) {
    throw new HttpError(400, `Elegí una cantidad entre ${MIN_PURCHASE.toLocaleString('es')} y ${MAX_PURCHASE.toLocaleString('es')} SMS`);
  }
  return credits;
}

function publicOrigin() {
  return (process.env.PUBLIC_APP_URL || String(process.env.WEB_ORIGIN || '').split(',')[0] || '').trim().replace(/\/$/, '');
}

// Link de pago de Winsap (tarjeta o QR) por credits × precio. Al pagarse, el webhook acredita el saldo solo.
async function createPurchase(organization, user, creditsInput) {
  const billing = require('./billing');
  const credits = validateCredits(creditsInput);
  const unitPrice = PRICE_GS();
  const amount = credits * unitPrice;
  const recent = await prisma.smsPurchase.findFirst({
    where: { organizationId: organization.id, source: 'CARD', status: 'pending', credits, unitPrice, paymentUrl: { not: null }, createdAt: { gt: new Date(Date.now() - 6 * HOUR) } },
    orderBy: { createdAt: 'desc' }
  });
  if (recent) return recent;
  const purchase = await prisma.smsPurchase.create({ data: { organizationId: organization.id, credits, unitPrice, amount, source: 'CARD', createdByUserId: user?.id || null } });
  const origin = publicOrigin();
  try {
    const link = await billing.winsap('POST', '/api/v1/payment-links', {
      name: `Niro · ${credits.toLocaleString('es')} SMS`,
      description: `Recarga de ${credits.toLocaleString('es')} SMS (${unitPrice} Gs. c/u) · ${organization.name}`,
      price: amount,
      currency: 'PYG',
      product_type: 'digital',
      success_url: `${origin}/sms?paid=1`,
      cancel_url: `${origin}/sms?cancelled=1`,
      webhook_url: `${origin}/api/billing/webhook/winsap-sms`,
      webhook_secret: billing.webhookSecret(),
      reference: `sms:${purchase.id}`,
      metadata: { smsPurchaseId: purchase.id, organizationId: organization.id, credits, email: user?.email || null }
    });
    const data = link.data || {};
    return prisma.smsPurchase.update({ where: { id: purchase.id }, data: { winsapLinkId: data.id != null ? String(data.id) : null, winsapLinkToken: data.token || null, paymentUrl: data.payment_url || null, raw: link } });
  } catch (err) {
    await prisma.smsPurchase.update({ where: { id: purchase.id }, data: { status: 'failed' } }).catch(() => {});
    throw err;
  }
}

// Acredita una compra pagada. Es idempotente: si el webhook llega dos veces (o a la vez que "verificar"), suma una sola vez.
async function activatePurchase(purchase, extra = {}) {
  const claimed = await prisma.smsPurchase.updateMany({ where: { id: purchase.id, status: { not: 'paid' } }, data: { status: 'paid', paidAt: new Date(), ...extra } });
  if (claimed.count === 0) return prisma.smsPurchase.findUnique({ where: { id: purchase.id } });
  const balance = await changeBalance(purchase.organizationId, purchase.credits, { type: 'PURCHASE', reference: purchase.id, note: `Recarga de ${purchase.credits.toLocaleString('es')} SMS` });
  emitToOrg(purchase.organizationId, 'sms:balance', { balance, purchaseId: purchase.id });
  return prisma.smsPurchase.findUnique({ where: { id: purchase.id } });
}

function pickPurchaseRef(ref) {
  const raw = ref.reference ? String(ref.reference) : '';
  return raw.startsWith('sms:') ? raw.slice(4) : null;
}

async function findPurchase(ref) {
  const id = pickPurchaseRef(ref);
  if (id) { const byRef = await prisma.smsPurchase.findUnique({ where: { id } }).catch(() => null); if (byRef) return byRef; }
  if (ref.linkId != null) { const byLink = await prisma.smsPurchase.findFirst({ where: { winsapLinkId: String(ref.linkId) } }); if (byLink) return byLink; }
  if (ref.token) return prisma.smsPurchase.findFirst({ where: { winsapLinkToken: String(ref.token) } });
  return null;
}

// Consulta a Winsap los pagos acreditados y acredita las recargas pendientes de la empresa.
async function syncPendingPurchases(organizationId) {
  const billing = require('./billing');
  const pending = await prisma.smsPurchase.findMany({ where: { organizationId, status: 'pending', source: 'CARD', winsapLinkId: { not: null } } });
  if (pending.length === 0) return 0;
  const list = await billing.winsap('GET', '/api/v1/payments?status=paid&limit=100');
  const rows = Array.isArray(list.data) ? list.data : [];
  let credited = 0;
  for (const purchase of pending) {
    const hit = rows.find((row) => {
      const meta = row.metadata || {};
      return row.reference === `sms:${purchase.id}` || meta.smsPurchaseId === purchase.id
        || (row.payment_link_id != null && String(row.payment_link_id) === purchase.winsapLinkId)
        || (row.link_id != null && String(row.link_id) === purchase.winsapLinkId)
        || (row.token && row.token === purchase.winsapLinkToken);
    });
    if (hit) {
      await activatePurchase(purchase, { winsapPaymentId: hit.id != null ? String(hit.id) : null, paymentMethod: hit.payment_method || null, raw: hit });
      credited += 1;
    }
  }
  return credited;
}

// Saldo asignado a mano por el superadmin (venta por transferencia, cortesía o corrección).
async function grantCredits(organizationId, credits, { userId, note, amount } = {}) {
  if (!Number.isInteger(credits) || credits === 0 || Math.abs(credits) > MAX_PURCHASE) throw new HttpError(400, 'La cantidad de SMS no es válida');
  if (credits < 0) {
    return { balance: await changeBalance(organizationId, credits, { type: 'ADJUSTMENT', note: note || 'Ajuste del administrador', userId }), purchase: null };
  }
  const unitPrice = PRICE_GS();
  const purchase = await prisma.smsPurchase.create({
    data: { organizationId, credits, unitPrice, amount: Number.isInteger(amount) && amount >= 0 ? amount : credits * unitPrice, status: 'paid', source: 'ADMIN', paidAt: new Date(), note: note || null, createdByUserId: userId || null }
  });
  const balance = await changeBalance(organizationId, credits, { type: 'PURCHASE', reference: purchase.id, note: note || 'Saldo asignado por el administrador', userId });
  emitToOrg(organizationId, 'sms:balance', { balance, purchaseId: purchase.id });
  return { balance, purchase };
}

module.exports = {
  PRICE_GS, PACKAGES, MIN_PURCHASE, MAX_PURCHASE, MAX_RECIPIENTS,
  changeBalance, getBalance, countsOf, getCounts, sanitizeCampaign, emitCampaign,
  resolveRecipients, createCampaign, assertBalanceFor, startCampaign, pauseCampaign, updatePausedCampaign, retryFailed, cancelCampaign, runCampaign, resumeCampaigns, tick,
  packageAmount, validateCredits, createPurchase, activatePurchase, findPurchase, syncPendingPurchases, grantCredits
};
