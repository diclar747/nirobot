const express = require('express');
const { prisma } = require('../lib/prisma');

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'niro-api',
    status: 'online',
    health: '/health',
    api: '/api'
  });
});

router.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: 'niro-api', database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, service: 'niro-api', database: 'unavailable' });
  }
});

router.get('/api', (_req, res) => {
  res.json({
    name: 'NIRO Enterprise API',
    version: '0.2.0',
    status: 'fase-1-nucleo-seguro'
  });
});

router.get('/api/public/org/:slug', async (req, res) => {
  try {
    const org = await prisma.organization.findUnique({
      where: { slug: req.params.slug },
      select: {
        id: true, name: true, slug: true, active: true,
        settings: { select: { welcomeMessage: true, aiEnabled: true } }
      }
    });
    if (!org || !org.active) return res.status(404).json({ error: 'Organización no encontrada' });
    res.json(org);
  } catch {
    res.status(500).json({ error: 'No se pudo consultar la organización' });
  }
});

module.exports = router;
