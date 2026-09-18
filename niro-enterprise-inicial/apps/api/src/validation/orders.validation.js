const { z } = require('zod');

const STATUSES = ['RECEIVED', 'CONFIRMED', 'PREPARING', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];

const orderItemSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().positive().max(100000).default(1),
  unitPrice: z.number().nonnegative().max(999999999).optional()
});

const createOrderSchema = z
  .object({
    contactId: z.string().min(1).optional(),
    newContact: z
      .object({
        name: z.string().min(1).max(120).optional(),
        phone: z.string().min(3).max(40).optional(),
        email: z.string().email().optional()
      })
      .optional(),
    conversationId: z.string().min(1).optional(),
    notes: z.string().max(2000).optional(),
    items: z.array(orderItemSchema).max(50).default([])
  })
  .refine((data) => data.contactId || (data.newContact && (data.newContact.name || data.newContact.phone || data.newContact.email)), {
    message: 'Se requiere un contacto existente o los datos de uno nuevo'
  });

const updateOrderSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    assignedToId: z.string().min(1).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    items: z.array(orderItemSchema).max(50).optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No hay cambios para aplicar' });

module.exports = { STATUSES, orderItemSchema, createOrderSchema, updateOrderSchema };
