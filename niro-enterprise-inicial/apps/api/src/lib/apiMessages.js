const { prisma } = require('./prisma');
const { HttpError } = require('./errors');
const { saveFile } = require('./storage');
const { extensionFor, isAllowedMimeType } = require('./attachments');
const { audit } = require('./audit');
const whatsapp = require('./whatsapp');
const { MESSAGE_INCLUDE, sanitizeMessage, broadcastMessage } = require('./conversations');

function normalizePhone(value) {
  const phone = String(value || '').replace(/[^0-9]/g, '');
  if (!/^\d{6,20}$/.test(phone)) throw new HttpError(400, 'El campo to debe contener un teléfono internacional válido');
  return phone;
}

function contentFor(type, text, caption) {
  if (type === 'text') return text || '';
  return text || caption || `[${type}]`;
}

function validateMedia(type, file, mimeType) {
  if (type === 'text') {
    if (!file) return;
    throw new HttpError(400, 'Un mensaje de texto no debe incluir un archivo');
  }
  if (!file) throw new HttpError(400, `El tipo ${type} requiere file o mediaBase64`);
  if (!isAllowedMimeType(mimeType)) throw new HttpError(400, 'Tipo de archivo no permitido para la API');
  if (type === 'image' && !mimeType.startsWith('image/')) throw new HttpError(400, 'El tipo image requiere una imagen');
  if (type === 'video' && !mimeType.startsWith('video/')) throw new HttpError(400, 'El tipo video requiere un video');
  if (type === 'audio' && !mimeType.startsWith('audio/')) throw new HttpError(400, 'El tipo audio requiere un audio');
  if (type === 'sticker' && mimeType !== 'image/webp') throw new HttpError(400, 'Los stickers deben enviarse en formato image/webp');
}

async function sendApiMessage({
  organizationId,
  apiKeyId,
  to,
  type = 'text',
  text,
  caption,
  file,
  fileName,
  mimeType,
  ptt,
  contactName,
  createContact = true
}) {
  const status = whatsapp.getStatus(organizationId);
  if (status.status !== 'connected') {
    throw new HttpError(409, 'WhatsApp no está conectado para esta organización');
  }

  const phone = normalizePhone(to);
  const normalizedType = String(type || 'text').toLowerCase();
  const finalMimeType = normalizedType === 'sticker' ? 'image/webp' : mimeType;
  validateMedia(normalizedType, file, finalMimeType);
  if (normalizedType === 'text' && !String(text || '').trim()) throw new HttpError(400, 'El mensaje de texto no puede estar vacío');

  let contact = await prisma.contact.findFirst({ where: { organizationId, phone } });
  if (!contact && createContact !== false) {
    contact = await prisma.contact.create({ data: { organizationId, phone, name: contactName || null } });
  }
  if (!contact) throw new HttpError(404, 'Contacto no encontrado para ese teléfono');

  // Un solo chat por contacto: si estaba cerrado se reabre en vez de crear otro en la lista.
  let conversation = await prisma.conversation.findFirst({
    where: { organizationId, contactId: contact.id, channel: 'whatsapp' },
    orderBy: { updatedAt: 'desc' }
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({ data: { organizationId, contactId: contact.id, channel: 'whatsapp' } });
  } else if (conversation.status === 'CLOSED') {
    conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: { status: 'OPEN' } });
  }

  let storageKey = null;
  if (file) storageKey = await saveFile(organizationId, file.buffer, extensionFor(finalMimeType));

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderUserId: null,
      apiKeyId,
      direction: 'OUTBOUND',
      content: contentFor(normalizedType, text, caption),
      contentType: normalizedType,
      deliveryStatus: 'pending',
      attachment: file
        ? { create: { organizationId, fileName: fileName || 'archivo', mimeType: finalMimeType, size: file.buffer.length, storageKey } }
        : undefined
    },
    include: MESSAGE_INCLUDE
  });

  try {
    const waMessageId = normalizedType === 'text'
      ? await whatsapp.sendText(organizationId, phone, text)
      : await whatsapp.sendMedia(organizationId, phone, {
          buffer: file.buffer,
          mimetype: finalMimeType,
          fileName: fileName || 'archivo',
          caption,
          ptt: ptt === true,
          kind: normalizedType
        });

    const sent = await prisma.message.update({
      where: { id: message.id },
      data: { waMessageId, deliveryStatus: 'sent' },
      include: MESSAGE_INCLUDE
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    broadcastMessage(organizationId, conversation.id, sent);
    await audit(prisma, {
      organizationId,
      actorUserId: null,
      action: 'api.message.sent',
      entityType: 'Message',
      entityId: sent.id,
      metadata: { apiKeyId, to: phone, type: normalizedType, waMessageId }
    });

    return {
      id: sent.id,
      conversationId: conversation.id,
      to: phone,
      type: normalizedType,
      status: sent.deliveryStatus,
      waMessageId,
      message: sanitizeMessage(sent)
    };
  } catch (err) {
    await prisma.message.update({ where: { id: message.id }, data: { deliveryStatus: 'failed' } }).catch(() => {});
    if (err && typeof err.status === 'number') throw err;
    throw new HttpError(502, `No se pudo enviar el mensaje por WhatsApp: ${err.message}`);
  }
}

module.exports = { normalizePhone, sendApiMessage };
