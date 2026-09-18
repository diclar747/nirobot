const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'NIRO WhatsApp API',
    version: '1.0.0',
    description: 'API multiempresa para enviar mensajes de WhatsApp desde integraciones externas. Cada API key solo puede operar sobre la organización que la creó.'
  },
  servers: [{ url: '/api/v1', description: 'Servidor NIRO' }],
  tags: [{ name: 'Mensajes', description: 'Envío de texto y multimedia' }, { name: 'Sesiones', description: 'Estado de las líneas de WhatsApp' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/messages': {
      post: {
        tags: ['Mensajes'],
        summary: 'Enviar un mensaje de WhatsApp',
        description: 'Usá JSON para texto o multipart/form-data para image, video, audio, document y sticker. Los emojis viajan como texto UTF-8. El archivo no debe superar 15 MB.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TextMessage' },
              example: { to: '595981234567', type: 'text', text: 'Hola 👋 Tu pedido está listo.' }
            },
            'multipart/form-data': {
              schema: { $ref: '#/components/schemas/MediaMessage' },
              encoding: { file: { contentType: 'image/jpeg, video/mp4, audio/ogg, application/pdf, image/webp' } }
            }
          }
        },
        responses: {
          201: { description: 'Mensaje enviado', content: { 'application/json': { schema: { $ref: '#/components/schemas/SendResponse' } } } },
          400: { description: 'Datos inválidos o archivo no permitido' },
          401: { description: 'API key inválida o ausente' },
          409: { description: 'La línea de WhatsApp no está conectada' },
          502: { description: 'WhatsApp rechazó el envío' }
        }
      }
    },
    '/sessions': {
      get: {
        tags: ['Sesiones'],
        summary: 'Consultar las sesiones disponibles',
        responses: { 200: { description: 'Sesiones de la organización', content: { 'application/json': { schema: { type: 'object', properties: { sessions: { type: 'array', items: { $ref: '#/components/schemas/Session' } } } } } } } }
      }
    }
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'NIRO API key' } },
    schemas: {
      TextMessage: {
        type: 'object',
        required: ['to', 'type', 'text'],
        properties: {
          to: { type: 'string', description: 'Teléfono internacional sin + ni espacios', example: '595981234567' },
          type: { type: 'string', enum: ['text'], default: 'text' },
          text: { type: 'string', maxLength: 8000 },
          createContact: { type: 'boolean', default: true }
        }
      },
      MediaMessage: {
        type: 'object',
        required: ['to', 'type', 'file'],
        properties: {
          to: { type: 'string', example: '595981234567' },
          type: { type: 'string', enum: ['image', 'video', 'audio', 'document', 'sticker'] },
          text: { type: 'string', description: 'Texto alternativo o contenido de la conversación' },
          caption: { type: 'string', description: 'Pie para imagen o video' },
          file: { type: 'string', format: 'binary' },
          mediaBase64: { type: 'string', description: 'Alternativa JSON a file; enviar junto con mimeType' },
          fileName: { type: 'string' },
          mimeType: { type: 'string', example: 'image/jpeg' },
          ptt: { type: 'boolean', description: 'En audio, enviarlo como nota de voz' },
          createContact: { type: 'boolean', default: true }
        }
      },
      SendResponse: {
        type: 'object',
        properties: {
          message: { type: 'object' },
          id: { type: 'string' },
          conversationId: { type: 'string' },
          to: { type: 'string' },
          type: { type: 'string' },
          status: { type: 'string', enum: ['sent'] },
          waMessageId: { type: 'string', nullable: true }
        }
      },
      Session: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          phone: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['disconnected', 'connecting', 'qr', 'connected'] },
          hasQr: { type: 'boolean' }
        }
      }
    }
  }
};

module.exports = { openapi };
