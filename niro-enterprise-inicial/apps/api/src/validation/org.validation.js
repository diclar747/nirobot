const { z } = require('zod');

const ORG_ROLES = ['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT'];

const updateOrgProfileSchema = z
  .object({ name: z.string().min(2).max(120).optional() })
  .refine((data) => Object.keys(data).length > 0, { message: 'No hay cambios para aplicar' });

const menuOptionSchema = z.object({
  key: z.string().min(1).max(10),
  label: z.string().min(1).max(60),
  departmentId: z.string().min(1)
});

const updateOrgSettingsSchema = z
  .object({
    welcomeMessage: z.string().min(1).max(2000).optional(),
    systemPrompt: z.string().max(8000).optional(),
    aiEnabled: z.boolean().optional(),
    menuOptions: z.array(menuOptionSchema).max(10).optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No hay cambios para aplicar' });

const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  role: z.enum(ORG_ROLES),
  password: z.string().min(10).optional()
});

const updateUserSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    role: z.enum(ORG_ROLES).optional(),
    active: z.boolean().optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No hay cambios para aplicar' });

const departmentSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional()
});

const updateDepartmentSchema = z
  .object({ name: z.string().min(2).max(120).optional(), description: z.string().max(500).optional() })
  .refine((data) => Object.keys(data).length > 0, { message: 'No hay cambios para aplicar' });

const addMemberSchema = z.object({ userId: z.string().min(1) });

module.exports = {
  ORG_ROLES,
  updateOrgProfileSchema,
  updateOrgSettingsSchema,
  createUserSchema,
  updateUserSchema,
  departmentSchema,
  updateDepartmentSchema,
  addMemberSchema
};
