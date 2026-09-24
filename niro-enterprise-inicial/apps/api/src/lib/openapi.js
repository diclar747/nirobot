const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'NIRO WhatsApp API',
    version: '1.0.0',
    description: 'API multiempresa para enviar mensajes de WhatsApp desde integraciones externas. Cada API key solo puede operar sobre la organización que la creó.'
  },
  servers: [{ url: '/api/v1', description: 'Servidor NIRO' }],
  tags: [
    { name: 'Mensajes', description: 'Envío de texto y multimedia' },
    { name: 'Sesiones', description: 'Estado de las líneas de WhatsApp' },
    { name: 'Estados', description: 'Publicar estados de WhatsApp (historias de 24 h)' },
    { name: 'Conversaciones', description: 'Leer chats, su historial y cambiar su estado' },
    { name: 'Contactos', description: 'Alta y consulta de contactos' },
    { name: 'SMS', description: 'Enviar SMS y consultar el saldo' },
    { name: 'Webhooks', description: 'Recibir avisos en tu servidor cuando pasa algo' },
    { name: 'Cuenta', description: 'Permisos de la clave y estado de la conexión' }
  ],
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
      },
      get: {
        tags: ['Mensajes'],
        summary: 'Mensajes desde una fecha (para recibir consultando)',
        description: 'Devuelve los mensajes ordenados del más viejo al más nuevo y un campo nextSince para la próxima consulta. Si preferís que te avisemos al instante, usá un webhook.',
        parameters: [
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Trae los posteriores a esta fecha (ISO 8601)' },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['INBOUND', 'OUTBOUND'] }, description: 'INBOUND = del cliente' },
          { name: 'conversationId', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }
        ],
        responses: { 200: { description: 'Mensajes', content: { 'application/json': { schema: { type: 'object', properties: {
          messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
          nextSince: { type: 'string', format: 'date-time', nullable: true }
        } } } } } }
      }
    },
    '/status': {
      post: {
        tags: ['Estados'],
        summary: 'Publicar un estado de WhatsApp',
        description: 'Texto, imagen o video. Usá JSON para texto (o para imagen/video con mediaBase64) y multipart/form-data para subir el archivo en el campo "file". Se publica al instante salvo que mandes mode=SCHEDULED con scheduledAt.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TextStatus' },
              example: { contentType: 'text', textContent: '¡Hoy 20% de descuento! 🎉', backgroundColor: '#075E54', audienceType: 'ALL' }
            },
            'multipart/form-data': {
              schema: { $ref: '#/components/schemas/MediaStatus' },
              encoding: { file: { contentType: 'image/jpeg, image/png, video/mp4' } }
            }
          }
        },
        responses: {
          201: { description: 'Estado creado (las inmediatas se envían en segundo plano)', content: { 'application/json': { schema: { type: 'object', properties: { status: { $ref: '#/components/schemas/StatusPost' } } } } } },
          400: { description: 'Datos inválidos, archivo no permitido o audiencia vacía' },
          401: { description: 'API key inválida o ausente' },
          409: { description: 'La línea de WhatsApp no está conectada' }
        }
      },
      get: {
        tags: ['Estados'],
        summary: 'Listar las últimas publicaciones',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }],
        responses: { 200: { description: 'Publicaciones', content: { 'application/json': { schema: { type: 'object', properties: { statuses: { type: 'array', items: { $ref: '#/components/schemas/StatusPost' } } } } } } } }
      }
    },
    '/status/{id}': {
      get: {
        tags: ['Estados'],
        summary: 'Consultar una publicación',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Publicación', content: { 'application/json': { schema: { type: 'object', properties: { status: { $ref: '#/components/schemas/StatusPost' } } } } } },
          404: { description: 'No encontrada' }
        }
      }
    },
    '/me': {
      get: {
        tags: ['Cuenta'],
        summary: 'Permisos de la clave y estado de WhatsApp',
        description: 'Sirve para comprobar si hay conexión antes de enviar.',
        responses: { 200: { description: 'Estado', content: { 'application/json': { schema: { type: 'object', properties: {
          organizationId: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          whatsapp: { type: 'object', properties: { connected: { type: 'boolean' }, status: { type: 'string', example: 'connected' }, sessions: { type: 'array', items: { $ref: '#/components/schemas/Session' } } } }
        } } } } } }
      }
    },
    '/conversations': {
      get: {
        tags: ['Conversaciones'],
        summary: 'Listar conversaciones',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }
        ],
        responses: { 200: { description: 'Conversaciones', content: { 'application/json': { schema: { type: 'object', properties: { conversations: { type: 'array', items: { $ref: '#/components/schemas/Conversation' } } } } } } } }
      }
    },
    '/conversations/{id}': {
      get: {
        tags: ['Conversaciones'],
        summary: 'Ver una conversación con su historial',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, description: 'Cantidad de mensajes' }
        ],
        responses: {
          200: { description: 'Conversación y mensajes', content: { 'application/json': { schema: { type: 'object', properties: { conversation: { $ref: '#/components/schemas/Conversation' }, messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } } } } },
          404: { description: 'No encontrada' }
        }
      },
      patch: {
        tags: ['Conversaciones'],
        summary: 'Cambiar estado, etiquetas, agente o área',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] },
            tags: { type: 'array', items: { type: 'string' } },
            assignedToId: { type: 'string', nullable: true, description: 'Id del agente' },
            departmentId: { type: 'string', nullable: true, description: 'Id del área' }
          }
        }, example: { status: 'CLOSED', tags: ['Cerradas'] } } } },
        responses: { 200: { description: 'Conversación actualizada' }, 404: { description: 'No encontrada' } }
      }
    },
    '/contacts': {
      get: {
        tags: ['Contactos'],
        summary: 'Listar contactos',
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Nombre o teléfono' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }
        ],
        responses: { 200: { description: 'Contactos', content: { 'application/json': { schema: { type: 'object', properties: { contacts: { type: 'array', items: { $ref: '#/components/schemas/Contact' } } } } } } } }
      },
      post: {
        tags: ['Contactos'],
        summary: 'Crear o actualizar un contacto por teléfono',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Contact' }, example: { name: 'Ana Gómez', phone: '595981234567', tags: ['vip'] } } } },
        responses: { 201: { description: 'Creado' }, 200: { description: 'Ya existía y se actualizó' } }
      }
    },
    '/sms': {
      post: {
        tags: ['SMS'],
        summary: 'Enviar SMS',
        description: 'A un número o a una lista. Descuenta del saldo de SMS de la empresa.',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object',
          required: ['to', 'message'],
          properties: {
            to: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Celular de Paraguay: 0985…, 985… o 595985…' },
            message: { type: 'string', maxLength: 1000 },
            name: { type: 'string', description: 'Reemplaza {nombre} en el texto' },
            stripAccents: { type: 'boolean', default: true, description: 'Quita tildes para que entre en un solo SMS' }
          }
        }, example: { to: ['0985768793', '0981222333'], message: 'Tu pedido esta listo!' } } } },
        responses: {
          201: { description: 'Envío creado', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, recipients: { type: 'integer' }, invalid: { type: 'array', items: { type: 'string' } }, status: { type: 'string' } } } } } },
          400: { description: 'Números inválidos, mensaje vacío o saldo insuficiente' }
        }
      }
    },
    '/sms/balance': {
      get: {
        tags: ['SMS'],
        summary: 'Consultar el saldo de SMS',
        responses: { 200: { description: 'Saldo', content: { 'application/json': { schema: { type: 'object', properties: { balance: { type: 'integer', description: 'SMS disponibles' }, priceGs: { type: 'integer' } } } } } } }
      }
    },
    '/sms/{id}': {
      get: {
        tags: ['SMS'],
        summary: 'Ver cómo salió un envío',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Estado por número', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, messages: { type: 'array', items: { type: 'object', properties: { phone: { type: 'string' }, status: { type: 'string', enum: ['PENDING','SENDING','SENT','DELIVERED','FAILED','CANCELLED'] }, errorMessage: { type: 'string', nullable: true }, sentAt: { type: 'string', format: 'date-time', nullable: true }, deliveredAt: { type: 'string', format: 'date-time', nullable: true } } } } } } } } } }
      }
    },
    '/webhooks': {
      get: {
        tags: ['Webhooks'],
        summary: 'Listar tus webhooks',
        responses: { 200: { description: 'Webhooks y eventos disponibles' } }
      },
      post: {
        tags: ['Webhooks'],
        summary: 'Registrar una URL para recibir avisos',
        description: 'Cada aviso llega por POST con los encabezados X-Niro-Event, X-Niro-Timestamp y X-Niro-Signature (HMAC SHA-256 de "timestamp.cuerpo" con tu secreto). El secreto se muestra una sola vez, al crearlo. Si tu servidor no responde 2xx, se reintenta dos veces.',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object',
          required: ['url', 'events'],
          properties: {
            url: { type: 'string', format: 'uri' },
            events: { type: 'array', items: { type: 'string', enum: ['message.received', 'message.status', 'conversation.updated', 'status.published'] } },
            active: { type: 'boolean', default: true }
          }
        }, example: { url: 'https://mi-sistema.com/niro/webhook', events: ['message.received', 'message.status'] } } } },
        responses: { 201: { description: 'Creado (incluye el secreto)' } }
      }
    },
    '/webhooks/{id}': {
      delete: {
        tags: ['Webhooks'],
        summary: 'Eliminar un webhook',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 204: { description: 'Eliminado' }, 404: { description: 'No encontrado' } }
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
      TextStatus: {
        type: 'object',
        required: ['contentType', 'textContent'],
        properties: {
          contentType: { type: 'string', enum: ['text'], default: 'text' },
          textContent: { type: 'string', maxLength: 700, description: 'Texto del estado' },
          backgroundColor: { type: 'string', example: '#075E54', description: 'Color de fondo en formato #RRGGBB' },
          fontStyle: { type: 'integer', minimum: 0, maximum: 5 },
          audienceType: { type: 'string', enum: ['ALL', 'TAG', 'CUSTOM'], default: 'ALL' },
          audienceTags: { type: 'array', items: { type: 'string' }, description: 'Etiquetas de contacto cuando audienceType=TAG' },
          audienceContactIds: { type: 'array', items: { type: 'string' }, description: 'Ids de contacto cuando audienceType=CUSTOM' },
          mode: { type: 'string', enum: ['NOW', 'SCHEDULED', 'DRAFT'], default: 'NOW' },
          scheduledAt: { type: 'string', format: 'date-time', description: 'Obligatorio con mode=SCHEDULED' }
        }
      },
      MediaStatus: {
        type: 'object',
        required: ['contentType'],
        properties: {
          contentType: { type: 'string', enum: ['image', 'video'] },
          file: { type: 'string', format: 'binary', description: 'Imagen o video del estado' },
          mediaBase64: { type: 'string', description: 'Alternativa a file: contenido en base64 (requiere mimeType)' },
          mimeType: { type: 'string', example: 'image/jpeg' },
          caption: { type: 'string', maxLength: 700, description: 'Texto sobre la imagen o el video' },
          audienceType: { type: 'string', enum: ['ALL', 'TAG', 'CUSTOM'], default: 'ALL' },
          audienceTags: { type: 'array', items: { type: 'string' } },
          audienceContactIds: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', enum: ['NOW', 'SCHEDULED', 'DRAFT'], default: 'NOW' },
          scheduledAt: { type: 'string', format: 'date-time' }
        }
      },
      StatusPost: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          contentType: { type: 'string', enum: ['text', 'image', 'video'] },
          status: { type: 'string', enum: ['draft', 'scheduled', 'processing', 'published', 'failed', 'expired'], description: 'processing = enviándose' },
          audienceCount: { type: 'integer', description: 'Contactos a los que se publica' },
          deliveredCount: { type: 'integer' },
          scheduledAt: { type: 'string', format: 'date-time', nullable: true },
          publishedAt: { type: 'string', format: 'date-time', nullable: true },
          errorMessage: { type: 'string', nullable: true }
        }
      },
      Conversation: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] },
          channel: { type: 'string', example: 'whatsapp' },
          tags: { type: 'array', items: { type: 'string' } },
          contact: { $ref: '#/components/schemas/Contact' },
          assignedTo: { type: 'object', nullable: true, properties: { id: { type: 'string' }, name: { type: 'string' } } },
          department: { type: 'object', nullable: true, properties: { id: { type: 'string' }, name: { type: 'string' } } },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Contact: {
        type: 'object',
        required: ['phone'],
        properties: {
          id: { type: 'string', readOnly: true },
          name: { type: 'string', nullable: true },
          phone: { type: 'string', example: '595981234567' },
          email: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' } }
        }
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          conversationId: { type: 'string' },
          direction: { type: 'string', enum: ['INBOUND', 'OUTBOUND', 'NOTE'] },
          content: { type: 'string' },
          contentType: { type: 'string', example: 'text' },
          deliveryStatus: { type: 'string', enum: ['pending', 'sent', 'delivered', 'read', 'failed'] },
          waMessageId: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' }
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
