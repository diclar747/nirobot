import '../styles/document-icon.css';

type DocTone = 'pdf' | 'word' | 'excel' | 'slides' | 'archive' | 'audio' | 'generic';

interface DocKind { label: string; tone: DocTone }

// Clasifica por mimeType y, si no alcanza, por la extensión del nombre de archivo — WhatsApp
// manda el nombre original del documento, así que un .zip sin mimeType reconocible igual se
// identifica bien.
function classify(mimeType: string, fileName: string): DocKind {
  const mime = (mimeType || '').toLowerCase();
  const ext = (fileName || '').toLowerCase().split('.').pop() || '';

  if (mime === 'application/pdf' || ext === 'pdf') return { label: 'PDF', tone: 'pdf' };
  if (mime.includes('word') || mime.includes('msword') || ['doc', 'docx', 'rtf', 'odt'].includes(ext)) return { label: 'DOC', tone: 'word' };
  if (mime.includes('sheet') || mime.includes('excel') || ['xls', 'xlsx', 'ods'].includes(ext)) return { label: 'XLS', tone: 'excel' };
  if (ext === 'csv' || mime === 'text/csv') return { label: 'CSV', tone: 'excel' };
  if (mime.includes('presentation') || mime.includes('powerpoint') || ['ppt', 'pptx', 'odp'].includes(ext)) return { label: 'PPT', tone: 'slides' };
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('rar') || mime.includes('7z') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return { label: ext && ['rar', '7z'].includes(ext) ? ext.toUpperCase() : 'ZIP', tone: 'archive' };
  }
  if (mime === 'text/plain' || ext === 'txt') return { label: 'TXT', tone: 'generic' };
  if (mime === 'application/json' || ext === 'json') return { label: 'JSON', tone: 'generic' };
  if (mime.startsWith('audio/')) return { label: 'AUDIO', tone: 'audio' };
  return { label: (ext || 'doc').slice(0, 4).toUpperCase(), tone: 'generic' };
}

/** Insignia con el formato del archivo (PDF, DOC, XLS, ZIP…) — mismo lugar que ocupaba el ícono genérico de clip. */
export function DocumentIcon({ mimeType, fileName, size = 38 }: { mimeType: string; fileName: string; size?: number }) {
  const { label, tone } = classify(mimeType, fileName);
  return (
    <span className={`doc-badge doc-badge-${tone}`} style={{ width: size, height: size, fontSize: Math.max(8, size * 0.26) }}>
      {label}
    </span>
  );
}
