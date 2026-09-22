// Una sola implementación de escape de CSV para las 6 exportaciones del sistema (contactos,
// grupos, gestión, SMS, llamadas, historial) — antes cada ruta tenía su propia copia y dos de
// ellas (management/sms/call) ni siquiera antepusieron el apóstrofo contra inyección de fórmulas
// de Excel (una celda que empieza con =, +, - o @ se interpreta como fórmula al abrirla).
function csvCell(value) {
  const text = String(value ?? '');
  // Un teléfono como "+595981234567" es dato legítimo, no una fórmula: se deja tal cual.
  const safe = /^[=+\-@]/.test(text) && !/^\+\d+$/.test(text) ? `'${text}` : text;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

module.exports = { csvCell };
