const { z } = require('zod');

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'La nueva contraseña debe tener al menos 10 caracteres')
});

const whatsappQrCompleteSchema = z.object({
  flowId: z.string().min(12).max(120),
  companyName: z.string().trim().min(2).max(100).optional(),
  adminName: z.string().trim().min(2).max(100).optional()
});

module.exports = { loginSchema, changePasswordSchema, whatsappQrCompleteSchema };
