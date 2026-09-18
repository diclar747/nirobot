const { PrismaClient } = require(process.env.PRISMA_CLIENT_PATH || '@prisma/client');

const prisma = new PrismaClient();

module.exports = { prisma };
