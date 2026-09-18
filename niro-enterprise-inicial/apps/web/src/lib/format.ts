export function initials(text: string) {
  return text
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function formatTime(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

export function contactLabel(contact: { name: string | null; phone: string | null; email: string | null }) {
  return contact.name || formatPhone(contact.phone) || contact.email || 'Sin nombre';
}

const PHONE_MAX_LENGTHS: Array<[string, number]> = [
  ['595', 12],
  ['591', 11],
  ['598', 11],
  ['54', 13],
  ['55', 13],
  ['56', 11],
  ['57', 10],
  ['58', 11],
  ['51', 11],
  ['52', 12],
  ['27', 11],
  ['34', 11],
  ['39', 12],
  ['44', 12],
  ['49', 15],
  ['91', 12],
  ['1', 11],
  ['7', 11]
];

export function phoneDigits(phone: string | null | undefined): string {
  return String(phone || '').replace(/[^0-9]/g, '');
}

// Baileys LIDs are internal WhatsApp identifiers. Older records can contain
// them in `phone`; displaying that value as a real telephone number is worse
// than explicitly indicating that the phone is not available yet.
export function isProbablyWhatsAppId(phone: string | null | undefined): boolean {
  const digits = phoneDigits(phone);
  if (!digits) return false;
  const match = PHONE_MAX_LENGTHS.find(([prefix]) => digits.startsWith(prefix));
  return Boolean(match && digits.length > match[1]);
}

export function isUsablePhone(phone: string | null | undefined): boolean {
  return Boolean(phone && !isProbablyWhatsAppId(phone));
}

export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  if (isProbablyWhatsAppId(phone)) return 'ID de WhatsApp';
  const cleaned = phone.replace(/[^0-9+]/g, '');
  if (cleaned.startsWith('595') && cleaned.length >= 11) {
    return `+595 ${cleaned.slice(3, 6)} ${cleaned.slice(6, 9)} ${cleaned.slice(9)}`;
  }
  if (cleaned.startsWith('+595') && cleaned.length >= 12) {
    return `+595 ${cleaned.slice(4, 7)} ${cleaned.slice(7, 10)} ${cleaned.slice(10)}`;
  }
  if (cleaned.startsWith('54') && cleaned.length >= 10) {
    return `+54 ${cleaned.slice(2, 5)} ${cleaned.slice(5, 9)} ${cleaned.slice(9)}`;
  }
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length >= 10) return `+${cleaned}`;
  return phone;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
