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

module.exports = { apiKeyNameSchema, apiMessageSchema, apiMessageTypes };
