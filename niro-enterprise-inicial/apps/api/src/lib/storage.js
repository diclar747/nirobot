const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Local-disk storage: the right default for the single-server Docker Compose deployment this
// project ships with (see docker-compose.yml — mounted as a named volume so uploads survive
// rebuilds). Swapping to S3/object storage later only means rewriting this one module; nothing
// else references the filesystem directly.
const STORAGE_ROOT = process.env.STORAGE_ROOT
  ? path.resolve(process.env.STORAGE_ROOT)
  : path.join(__dirname, '..', '..', 'storage', 'uploads');

async function saveFile(organizationId, buffer, extension) {
  const dir = path.join(STORAGE_ROOT, organizationId);
  await fsp.mkdir(dir, { recursive: true });
  const key = `${organizationId}/${crypto.randomUUID()}${extension}`;
  await fsp.writeFile(path.join(STORAGE_ROOT, key), buffer);
  return key;
}

function resolvePath(storageKey) {
  const full = path.join(STORAGE_ROOT, storageKey);
  // storageKey is always server-generated (never taken verbatim from a request), but this stays
  // as a defense-in-depth guard against ever reading outside STORAGE_ROOT.
  const rootWithSep = STORAGE_ROOT.endsWith(path.sep) ? STORAGE_ROOT : STORAGE_ROOT + path.sep;
  if (!full.startsWith(rootWithSep)) throw new Error('Invalid storage key');
  return full;
}

async function deleteFile(storageKey) {
  try {
    await fsp.unlink(resolvePath(storageKey));
  } catch {
    // best-effort cleanup; a missing file on disk shouldn't block the caller
  }
}

function existsSync(storageKey) {
  try {
    return fs.existsSync(resolvePath(storageKey));
  } catch {
    return false;
  }
}

module.exports = { STORAGE_ROOT, saveFile, resolvePath, deleteFile, existsSync };
