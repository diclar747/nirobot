const { prisma } = require('./prisma');
const { emitToOrg } = require('./realtime');

function normalizeAnswer(value) {
  return String(value || '').trim().toLowerCase().replace(/[.)]/g, '');
}

async function registerInboundResponse(organizationId, phone, text) {
  if (!phone || !text) return null;
  const surveys = await prisma.callSurvey.findMany({
    where: {
      responseMethod: 'WHATSAPP',
      campaign: { organizationId, status: { in: ['RUNNING', 'PAUSED', 'COMPLETED'] } },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
    },
    include: { options: true, campaign: { select: { id: true, organizationId: true } } }
  });
  const answer = normalizeAnswer(text);
  for (const survey of surveys) {
    const contact = await prisma.contact.findFirst({ where: { organizationId, phone } });
    if (!contact) continue;
    const option = survey.options.find((candidate) => normalizeAnswer(candidate.optionKey) === answer);
    if (!option) continue;
    const recipient = await prisma.callCampaignRecipient.findFirst({
      where: { campaignId: survey.campaignId, contactId: contact.id, status: 'COMPLETED' },
      orderBy: { updatedAt: 'desc' },
      include: { attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 } }
    });
    if (!recipient) continue;
    const response = await prisma.callSurveyResponse.create({
      data: {
        surveyId: survey.id,
        campaignId: survey.campaignId,
        contactId: contact.id,
        attemptId: recipient.attempts[0] ? recipient.attempts[0].id : null,
        responseValue: option.optionKey,
        responseChannel: 'WHATSAPP'
      }
    });
    emitToOrg(organizationId, 'wa-call:survey_response', { campaignId: survey.campaignId, response });
    return response;
  }
  return null;
}

module.exports = { registerInboundResponse };
