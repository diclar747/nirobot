const request = require('supertest');
const { hashPassword } = require('../../src/lib/passwords');

const DEFAULT_PASSWORD = 'correct-horse-battery-staple';

async function createOrganization(prisma, { slug, name, maxUsers } = {}) {
  return prisma.organization.create({
    data: {
      name: name || `Org ${slug}`,
      slug,
      maxUsers: maxUsers || 20,
      settings: { create: {} }
    }
  });
}

async function createUser(prisma, { organizationId, email, role = 'AGENT', password = DEFAULT_PASSWORD, active = true, autoChat = false }) {
  const passwordHash = await hashPassword(password);
  return prisma.user.create({
    data: { organizationId: organizationId ?? null, name: email.split('@')[0], email, role, passwordHash, active, autoChat }
  });
}

function extractCookieValue(setCookieHeader, name) {
  const line = (setCookieHeader || []).find((c) => c.startsWith(`${name}=`));
  if (!line) return null;
  return line.split(';')[0].split('=')[1];
}

async function loginAgent(app, email, password = DEFAULT_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`Login falló para ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const csrfToken = extractCookieValue(res.headers['set-cookie'], 'niro_csrf');
  return { agent, csrfToken, user: res.body.user };
}

module.exports = { DEFAULT_PASSWORD, createOrganization, createUser, loginAgent, extractCookieValue };
