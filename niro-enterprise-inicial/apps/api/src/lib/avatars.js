// Contact.avatarUrl guarda una de tres cosas: un link externo puesto a mano (queda tal cual), una
// storageKey local ("orgId/archivo", de una foto que bajamos nosotros de WhatsApp — ver
// whatsapp.js downloadAvatarToStorage) o un link viejo de WhatsApp ya vencido (se guardaba así
// antes de ese cambio). Solo el segundo caso necesita armarse como URL — todo lugar que muestre
// la foto de un contacto (Inbox, Estados, Dashboard, Historial, Campañas, Llamadas, Contactos)
// tiene que pasar por acá para no repetir esta lógica ni mostrar una storageKey cruda como si
// fuera una URL.
function contactAvatarUrlFor(value) {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `/api/org/contacts/avatar/${value}`;
}

module.exports = { contactAvatarUrlFor };
