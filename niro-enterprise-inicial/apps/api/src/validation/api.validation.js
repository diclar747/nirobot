const { z } = require('zod');

const apiKeyNameSchema = z.object({
  name: z.string().trim().min(2).max(80)
});

const apiMessageTypes = ['text', 'image', 'video', 'audio', 'document', 'sticker'];

const apiMessageSchema = z.object({
  to: z.string().trim().min(6).max(40),
  type: z.enum(apiMessageTypes).default('text'),
  text: z.string().max(8000).optional(),
  caption: z.string().max(8000).optional(),
  fileName: z.string().max(200).optional(),
  mimeType: z.string().max(120).optional(),
  ptt: z.union([z.boolean(), z.string().transform((value) => value === 'true')]).optional(),
  contactName: z.string().max(120).optional(),
  createContact: z.union([z.boolean(), z.string().transform((value) => value !== 'false')]).optional()
});

// Estados de WhatsApp por API: texto, imagen o video. Los campos de lista llegan como JSON, lista separada por
// comas o arreglo real (según el cliente mande JSON o multipart).
const apiList = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* lista por comas */ }
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return value;
}, z.array(z.string().min(1).max(60)).max(500));

const apiStatusSchema = z.object({
  contentType: z.enum(['text', 'image', 'video']).default('text'),
  textContent: z.string().max(700).optional(),
  caption: z.string().max(700).optional(),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fontStyle: z.coerce.number().int().min(0).max(5).optional(),
  audienceType: z.enum(['ALL', 'TAG', 'CUSTOM']).default('ALL'),
  audienceTags: apiList,
  audienceContactIds: apiList,
  mode: z.enum(['NOW', 'SCHEDULED', 'DRAFT']).default('NOW'),
  scheduledAt: z.string().min(10).optional(),
  fileName: z.string().max(200).optional(),
  mimeType: z.string().max(120).optional()
});

// Conversaciones, contactos y SMS por API.
const apiConversationPatchSchema = z.object({
  status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'CLOSED']).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  assignedToId: z.string().max(80).nullable().optional(),
  departmentId: z.string().max(80).nullable().optional()
}).refine((data) => Object.keys(data).length > 0, { message: 'No hay cambios para aplicar' });

const apiContactSchema = z.object({
  name: z.string().trim().max(120).optional(),
  phone: z.string().trim().min(6).max(40),
  email: z.string().email().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional()
});

const apiSmsSchema = z.object({
  to: z.union([z.string().trim().min(6).max(40), z.array(z.string().trim().min(6).max(40)).min(1).max(1000)]),
  message: z.string().min(1).max(1000),
  name: z.string().trim().max(120).optional(),
  stripAccents: z.union([z.boolean(), z.string().transform((value) => value !== 'false')]).optional()
});

const apiWebhookSchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.enum(['message.received', 'message.status', 'conversation.updated', 'status.published'])).min(1).max(10),
  active: z.boolean().optional()
});

module.exports = {
  apiKeyNameSchema, apiMessageSchema, apiMessageTypes, apiStatusSchema,
  apiConversationPatchSchema, apiContactSchema, apiSmsSchema, apiWebhookSchema
};
