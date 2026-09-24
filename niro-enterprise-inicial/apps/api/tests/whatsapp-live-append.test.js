const whatsapp = require('../src/lib/whatsapp');

// WhatsApp manda type 'append' tanto para el historial viejo como para mensajes en vivo que caen mientras la
// sesión sincroniza. Se distinguen por la fecha: los recientes tienen que ir por el camino en vivo (bot incluido).
describe('Mensajes "append": en vivo vs historial', () => {
  const now = Date.now();
  const at = (secondsAgo) => ({ messageTimestamp: Math.floor(now / 1000) - secondsAgo });

  test('un mensaje de hace segundos es en vivo', () => {
    expect(whatsapp.isRecentMessage(at(5), now)).toBe(true);
    expect(whatsapp.isRecentMessage(at(4 * 60), now)).toBe(true);
  });

  test('un mensaje de hace horas es historial', () => {
    expect(whatsapp.isRecentMessage(at(60 * 60), now)).toBe(false);
    expect(whatsapp.isRecentMessage(at(6 * 60), now)).toBe(false);
  });

  test('sin fecha se asume en vivo (no perder una respuesta del bot)', () => {
    expect(whatsapp.isRecentMessage({}, now)).toBe(true);
  });

  test('acepta el timestamp como objeto Long de Baileys', () => {
    expect(whatsapp.isRecentMessage({ messageTimestamp: { toNumber: () => Math.floor(now / 1000) - 10 } }, now)).toBe(true);
  });
});
