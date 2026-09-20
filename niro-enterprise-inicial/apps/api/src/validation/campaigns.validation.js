const { z } = require('zod');

const speedProfiles = ['CONSERVATIVE', 'BALANCED', 'PERFORMANCE', 'HIGH_PERFORMANCE'];

const createCampaignSchema = z.object({
  name: z.string().min(1).max(150),
  message: z.string().min(1).max(4000),
  tagFilter: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  contactIds: z.array(z.string().min(1).max(80)).max(10000).default([]),
  groupJids: z.array(z.string().regex(/^[\w.-]+@g\.us$/)).max(500).default([]),
  sendLine: z.string().trim().max(80).nullable().optional(),
  campaignType: z.enum(['DIRECT', 'SCHEDULED']).optional(),
  speedProfile: z.enum(speedProfiles).default('BALANCED'),
  messagesPerHour: z.number().int().min(1).max(100).optional(),
  ratePerMinute: z.number().int().min(1).max(120).optional(),
  scheduledAt: z.string().datetime().optional()
}).superRefine((data, ctx) => {
  if (data.tagFilter.length === 0 && data.contactIds.length === 0 && data.groupJids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['audience'], message: 'Seleccioná al menos una etiqueta, un contacto o un grupo' });
  }
  if ((data.campaignType === 'SCHEDULED' || data.scheduledAt) && !data.scheduledAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduledAt'], message: 'Una campaña programada necesita fecha y hora' });
  }
});

module.exports = { createCampaignSchema, speedProfiles };
