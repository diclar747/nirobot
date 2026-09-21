const { z } = require('zod');

const STATUSES = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const MESSAGE_TYPES = ['outbound', 'inbound', 'note'];

const contactSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    phone: z.string().min(3).max(40).optional(),
    email: z.string().email().optional(),
    externalId: z.string().max(120).optional()
  })
  .refine((data) => data.name || data.phone || data.email, {
    message: 'Se requiere al menos nombre, teléfono o email'
  });

const createConversationSchema = z
  .object({
    contactId: z.string().min(1).optional(),
    newContact: z
      .object({
        name: z.string().min(1).max(120).optional(),
        phone: z.string().min(3).max(40).optional(),
        email: z.string().email().optional()
      })
      .optional(),
    subject: z.string().max(200).optional(),
    departmentId: z.string().min(1).optional(),
    channel: z.string().min(1).max(40).optional()
  })
  .refine((data) => data.contactId || (data.newContact && (data.newContact.name || data.newContact.phone || data.newContact.email)), {
    message: 'Se requiere un contacto existente o los datos de uno nuevo'
  });

const outcomeInput = z.object({
  categoryId: z.string().min(1),
  amount: z.union([z.number(), z.string().max(30)]).nullable().optional(),
  note: z.string().max(500).nullable().optional()
});

const outcomeRequestSchema = outcomeInput.extend({
  close: z.boolean().optional(),
  status: z.enum(['RESOLVED', 'CLOSED']).optional()
});

const updateConversationSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    departmentId: z.string().min(1).nullable().optional(),
    assignedToId: z.string().min(1).nullable().optional(),
    subject: z.string().max(200).nullable().optional(),
    tags: z.array(z.string().min(1).max(30)).max(15).optional(),
    // Cómo terminó la conversación: obligatorio al cerrarla/resolverla (ver lib/outcomes.js).
    outcome: outcomeInput.optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No hay cambios para aplicar' });

const createMessageSchema = z.object({
  content: z.string().min(1).max(8000),
  type: z.enum(MESSAGE_TYPES).optional(),
  quotedMessageId: z.string().min(1).optional()
});

const reactionSchema = z.object({
  emoji: z.string().max(8).nullable()
});

const createPollSchema = z.object({
  question: z.string().min(1).max(300),
  options: z.array(z.string().min(1).max(100)).min(2).max(12)
});

const shareContactSchema = z.object({
  contactId: z.string().min(1)
});

module.exports = {
  STATUSES,
  PRIORITIES,
  MESSAGE_TYPES,
  contactSchema,
  createConversationSchema,
  updateConversationSchema,
  outcomeInput,
  outcomeRequestSchema,
  createMessageSchema,
  reactionSchema,
  createPollSchema,
  shareContactSchema
};
