const { z } = require('zod');

const AGENT_CATEGORIES = ['CHAT', 'CODING', 'RESEARCH'];

const createAgentSchema = z.object({
  name: z.string().min(2).max(120),
  systemPrompt: z.string().min(1).max(8000),
  description: z.string().max(500).optional(),
  category: z.enum(AGENT_CATEGORIES).optional()
});

const chatMessageSchema = z.object({
  role: z.enum(['user', 'system', 'assistant']),
  content: z.string().min(1).max(8000)
});

const agentChatSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(40)
});

const testChatSchema = z.object({
  message: z.string().min(1).max(4000)
});

module.exports = { AGENT_CATEGORIES, createAgentSchema, agentChatSchema, testChatSchema };
