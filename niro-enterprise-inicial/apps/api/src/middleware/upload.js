const multer = require('multer');
const { MAX_SIZE, isAllowedMimeType } = require('../lib/attachments');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (!isAllowedMimeType(file.mimetype)) {
      return cb(new Error('Tipo de archivo no permitido'));
    }
    cb(null, true);
  }
});

module.exports = { upload };
