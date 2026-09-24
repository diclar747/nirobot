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

const botNodeSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(['start', 'message', 'menu', 'keyword', 'condition', 'ai', 'crm', 'agent', 'end']),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional().default(''),
  position: z.object({ x: z.number().finite().min(0).max(5000), y: z.number().finite().min(0).max(5000) }),
  data: z.record(z.any()).optional().default({})
});

const botEdgeSchema = z.object({
  id: z.string().min(1).max(100),
  from: z.string().min(1).max(80),
  to: z.string().min(1).max(80),
  label: z.string().max(40).optional().default('')
});

const botFlowSchema = z.object({
  version: z.number().int().min(1).max(10).default(1),
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(false),
  published: z.boolean().default(false),
  nodes: z.array(botNodeSchema).max(80),
  edges: z.array(botEdgeSchema).max(160)
});

// El simulador manda, además del mensaje, el estado de la conversación simulada: así el primer mensaje se trata
// como conversación nueva (saludo/menú) y, una vez derivada, el bot deja de responder igual que en la realidad.
const botFlowTestSchema = z.object({
  message: z.string().min(1).max(2000),
  flow: botFlowSchema.optional(),
  state: z.object({
    started: z.boolean().default(false),
    tags: z.array(z.string().max(40)).max(30).default([]),
    assignedToId: z.string().max(80).nullable().default(null),
    lastBotReply: z.string().max(4000).default(''),
    departmentId: z.string().max(80).nullable().default(null)
  }).optional()
});

const updateOrgSettingsSchema = z
  .object({
    welcomeMessage: z.string().min(1).max(2000).optional(),
    systemPrompt: z.string().max(8000).optional(),
    aiEnabled: z.boolean().optional(),
    autoTranscribeAudio: z.boolean().optional(),
    menuOptions: z.array(menuOptionSchema).max(10).optional(),
    botFlow: botFlowSchema.optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'No hay cambios para aplicar' });

const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  role: z.enum(ORG_ROLES),
  password: z.string().min(10).optional(),
  // Opcional: si se manda, se le avisa por WhatsApp con su usuario/contraseña al crearlo.
  phone: z.string().trim().min(6).max(40).optional(),
  departmentIds: z.array(z.string().min(1)).max(50).optional(),
  autoChat: z.boolean().optional()
});

const updateUserSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    role: z.enum(ORG_ROLES).optional(),
    active: z.boolean().optional(),
    phone: z.string().trim().min(6).max(40).nullable().optional(),
    permissions: z.record(z.string(), z.boolean()).optional(),
    departmentIds: z.array(z.string().min(1)).max(50).optional(),
    autoChat: z.boolean().optional()
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
  botFlowSchema,
  botFlowTestSchema,
  createUserSchema,
  updateUserSchema,
  departmentSchema,
  updateDepartmentSchema,
  addMemberSchema
};
