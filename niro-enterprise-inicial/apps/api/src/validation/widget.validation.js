const { z } = require('zod');

const startSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(3).max(40).optional()
});

const messageSchema = z.object({
  token: z.string().min(10).max(200),
  content: z.string().min(1).max(4000)
});

const tokenSchema = z.object({
  token: z.string().min(10).max(200)
});

module.exports = { startSchema, messageSchema, tokenSchema };
