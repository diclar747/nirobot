const { createCallCampaignSchema } = require('../src/validation/call.validation');

describe('validación de campañas de llamadas', () => {
  test('obliga a usar audiencia y consentimiento mediante el flujo de creación', () => {
    const result = createCallCampaignSchema.safeParse({ name: 'Campaña', accountId: 'a', audioId: 'b' });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.path.includes('contactIds'))).toBe(true);
  });

  test('valida la encuesta y normaliza los límites configurables', () => {
    const result = createCallCampaignSchema.parse({
      name: 'Encuesta', accountId: 'a', audioId: 'b', contactIds: ['c'], maxConcurrent: 2, maxAttempts: 3,
      surveyEnabled: true, surveyQuestion: '¿Te interesa?', surveyOptions: [{ key: '1', label: 'Sí' }, { key: '2', label: 'No' }]
    });
    expect(result.maxConcurrent).toBe(2);
    expect(result.maxAttempts).toBe(3);
    expect(result.surveyResponseMethod).toBe('WHATSAPP');
  });
});
