const { z } = require('zod');

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'La nueva contraseña debe tener al menos 10 caracteres')
});

module.exports = { loginSchema, changePasswordSchema };
