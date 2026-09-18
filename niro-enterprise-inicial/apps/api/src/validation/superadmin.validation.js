const { z } = require('zod');

const slug = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Formato de slug inválido (usar minúsculas, números y guiones)');

const createOrganizationSchema = z.object({
  name: z.string().min(2).max(120),
  slug,
  planTier: z.string().min(1).max(40).optional(),
  maxUsers: z.number().int().positive().max(100000).optional(),
  ownerName: z.string().min(2).max(120),
  ownerEmail: z.string().email()
});

const updateOrganizationSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    active: z.boolean().optional(),
    planTier: z.string().min(1).max(40).optional(),
    maxUsers: z.number().int().positive().max(100000).optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No hay cambios para aplicar' });

module.exports = { createOrganizationSchema, updateOrganizationSchema };
