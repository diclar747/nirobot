process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://niro:niro@localhost:5432/niro_test?schema=public';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-do-not-use-in-production';
process.env.COOKIE_SECURE = 'false';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.STORAGE_ROOT = process.env.STORAGE_ROOT || require('path').join(__dirname, '..', '..', 'storage', 'test-uploads');

const { app } = require('../../src/app');
const { prisma } = require('../../src/lib/prisma');
const campaigns = require('../../src/lib/campaigns');

async function resetDb() {
  campaigns.clearAllTimers();
  await prisma.$transaction([
    prisma.refreshToken.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.message.deleteMany(),
    prisma.apiKey.deleteMany(),
    prisma.campaignRecipient.deleteMany(),
    prisma.campaign.deleteMany(),
    prisma.conversation.deleteMany(),
    prisma.departmentMember.deleteMany(),
    prisma.department.deleteMany(),
    prisma.contact.deleteMany(),
    prisma.user.deleteMany(),
    prisma.organizationSettings.deleteMany(),
    prisma.organization.deleteMany()
  ]);
}

module.exports = { app, prisma, resetDb };
