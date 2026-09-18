const { ZodError } = require('zod');
const multer = require('multer');

function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Datos inválidos', details: err.issues });
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el tamaño máximo permitido (15 MB)' : 'No se pudo subir el archivo';
    return res.status(400).json({ error: message });
  }
  if (err && err.message === 'Tipo de archivo no permitido') {
    return res.status(400).json({ error: err.message });
  }
  if (err && typeof err.status === 'number') {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[NIRO API]', err);
  res.status(500).json({ error: 'Error interno del servidor' });
}

module.exports = { errorHandler };
