const { z } = require('zod');

const createCallCampaignSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  campaignType: z.enum(['COMMERCIAL', 'NOTIFICATION', 'FOLLOW_UP', 'SURVEY', 'INSTITUTIONAL']).default('COMMERCIAL'),
  accountId: z.string().min(1),
  audioId: z.string().min(1),
  contactIds: z.array(z.string().min(1)).max(10000).default([]),
  tagFilter: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
  timezone: z.string().trim().min(1).max(80).default('America/Asuncion'),
  maxConcurrent: z.coerce.number().int().min(1).max(5).default(1),
  pauseBetweenSeconds: z.coerce.number().int().min(0).max(3600).default(10),
  maxAttempts: z.coerce.number().int().min(1).max(3).default(1),
  answerTimeoutSeconds: z.coerce.number().int().min(10).max(180).default(30),
  retryDelaySeconds: z.coerce.number().int().min(30).max(86400).default(300),
  allowedFrom: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
  allowedTo: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
  surveyEnabled: z.coerce.boolean().default(false),
  surveyQuestion: z.string().trim().max(300).optional().nullable(),
  surveyResponseMethod: z.enum(['WHATSAPP', 'FORM']).default('WHATSAPP'),
  surveyExpiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  surveyOptions: z.array(z.object({
    key: z.string().trim().min(1).max(10), label: z.string().trim().min(1).max(120),
    replyMessage: z.string().trim().max(1000).optional().nullable(),
    action: z.enum(['NONE', 'INTERESTED', 'FOLLOW_UP', 'OPT_OUT']).default('NONE')
  })).max(10).default([])
}).superRefine((data, ctx) => {
  if (data.contactIds.length === 0 && data.tagFilter.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contactIds'], message: 'Seleccioná contactos o al menos una etiqueta' });
  }
  if (data.surveyEnabled && (!data.surveyQuestion || data.surveyOptions.length < 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['surveyOptions'], message: 'La encuesta necesita una pregunta y al menos dos opciones' });
  }
  const keys = new Set();
  for (const option of data.surveyOptions) {
    if (keys.has(option.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['surveyOptions'], message: 'Las opciones de encuesta no pueden repetirse' });
    keys.add(option.key);
  }
});

module.exports = { createCallCampaignSchema };
