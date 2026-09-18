const { isRealPersonJid, phoneFromJid, resolvePhoneJid } = require('../src/lib/whatsapp');

describe('identificadores de WhatsApp', () => {
  test('no trata un LID como teléfono', () => {
    expect(isRealPersonJid('100309716181177@lid')).toBe(true);
    expect(phoneFromJid('100309716181177@lid')).toBeNull();
  });

  test('resuelve un LID al número real usando el mapeo de Baileys', async () => {
    const sock = {
      signalRepository: {
        lidMapping: {
          getPNForLID: jest.fn().mockResolvedValue('595981123456:0@s.whatsapp.net')
        }
      }
    };

    const resolved = await resolvePhoneJid(sock, '100309716181177@lid');

    expect(resolved).toBe('595981123456:0@s.whatsapp.net');
    expect(phoneFromJid(resolved)).toBe('595981123456');
    expect(sock.signalRepository.lidMapping.getPNForLID).toHaveBeenCalledWith('100309716181177@lid');
  });

  test('no inventa un teléfono cuando Baileys todavía no tiene el mapeo', async () => {
    const sock = { signalRepository: { lidMapping: { getPNForLID: jest.fn().mockResolvedValue(null) } } };

    expect(await resolvePhoneJid(sock, '278996931612748@hosted.lid')).toBeNull();
    expect(phoneFromJid('278996931612748@hosted.lid')).toBeNull();
  });
});
