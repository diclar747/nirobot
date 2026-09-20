const callProvider = require('../src/lib/callProvider');

describe('proveedor de llamadas', () => {
  afterEach(() => {
    delete process.env.WHATSAPP_CALL_PROVIDER;
  });

  test('el simulador recorre ringing, connected y ended', async () => {
    process.env.WHATSAPP_CALL_PROVIDER = 'mock';
    const events = [];
    const call = await callProvider.startCall({ id: 'local-account', sessionReference: 'local' }, '595981123456', { audioSource: 'local.wav', durationMs: 120 });
    call.on('ringing', () => events.push('ringing'));
    call.on('connected', () => events.push('connected'));
    const reason = await call.waitForEnd();

    expect(events).toEqual(['ringing', 'connected']);
    expect(reason).toBe('audio_complete');
    expect(call.callId).toMatch(/^mock-/);
  });

  test('sin proveedor no permite declarar una llamada real', async () => {
    delete process.env.WHATSAPP_CALL_PROVIDER;
    await expect(callProvider.startCall({ id: 'account', sessionReference: 'session' }, '595981123456', {})).rejects.toMatchObject({ code: 'CALL_PROVIDER_UNAVAILABLE' });
  });
});
