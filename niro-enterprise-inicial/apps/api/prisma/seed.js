const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('[seed] Iniciando configuración de datos demo de NIRO Enterprise...');

  // 1. SUPERADMIN
  const superadminEmail = process.env.SEED_SUPERADMIN_EMAIL || 'superadmin@niro.com';
  const superadminPass = process.env.SEED_SUPERADMIN_PASSWORD || 'Password123!';
  const superadminHash = await bcrypt.hash(superadminPass, 10);

  let superadmin = await prisma.user.findUnique({ where: { email: superadminEmail } });
  if (!superadmin) {
    superadmin = await prisma.user.create({
      data: {
        name: 'Claudio Méndez (Superadmin)',
        email: superadminEmail,
        passwordHash: superadminHash,
        role: 'SUPERADMIN',
        organizationId: null,
        mustChangePassword: false
      }
    });
    console.log(`[seed] ✓ Superadmin creado: ${superadmin.email}`);
  } else {
    console.log(`[seed] - Superadmin ya existe: ${superadmin.email}`);
  }

  // 2. ORGANIZACIÓN DEMO ("Ferretería El Sol")
  let org = await prisma.organization.findUnique({ where: { slug: 'ferreteria-el-sol' } });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'Ferretería El Sol',
        slug: 'ferreteria-el-sol',
        active: true,
        planTier: 'enterprise',
        maxUsers: 50,
        settings: {
          create: {
            systemPrompt: 'Eres NIRO, el asistente virtual inteligente de Ferretería El Sol.',
            welcomeMessage: '¡Hola! Soy NIRO, tu asistente virtual. ¿En qué podemos ayudarte hoy?',
            aiEnabled: true
          }
        }
      }
    });
    console.log(`[seed] ✓ Organización demo creada: ${org.name}`);
  }

  // 3. DEPARTAMENTOS
  let depVentas = await prisma.department.findFirst({
    where: { organizationId: org.id, name: 'Ventas' }
  });
  if (!depVentas) {
    depVentas = await prisma.department.create({
      data: {
        organizationId: org.id,
        name: 'Ventas',
        description: 'Atención comercial, cotizaciones y pedidos'
      }
    });
  }

  let depSoporte = await prisma.department.findFirst({
    where: { organizationId: org.id, name: 'Soporte y Logística' }
  });
  if (!depSoporte) {
    depSoporte = await prisma.department.create({
      data: {
        organizationId: org.id,
        name: 'Soporte y Logística',
        description: 'Entregas, envíos y seguimiento de pedidos'
      }
    });
  }

  // El menú del bot referencia IDs de departamento que recién existen en este punto (no se
  // puede crear al mismo tiempo que la organización). Se actualiza siempre, no solo en la
  // creación inicial, para autocorregir datos demo sembrados por una versión anterior de este
  // script cuyo formato de menuOptions no coincidía con el que espera lib/bot.js.
  await prisma.organizationSettings.update({
    where: { organizationId: org.id },
    data: {
      menuOptions: [
        { key: '1', label: 'ventas y cotizaciones', departmentId: depVentas.id },
        { key: '2', label: 'soporte y seguimiento de pedidos', departmentId: depSoporte.id }
      ]
    }
  });

  // Contraseña común para usuarios demo
  const demoPasswordHash = await bcrypt.hash('Password123!', 10);

  // 4. USUARIOS DEMO (OWNER, SUPERVISOR, AGENTES)
  const demoUsers = [
    {
      name: 'Claudio Méndez (Admin)',
      email: 'admin@ferreteria.com',
      role: 'OWNER',
      departmentId: depVentas.id
    },
    {
      name: 'Ana Rodríguez (Supervisora)',
      email: 'supervisor@ferreteria.com',
      role: 'SUPERVISOR',
      departmentId: depVentas.id
    },
    {
      name: 'Carlos Méndez (Ventas)',
      email: 'agente@empresa.com',
      role: 'AGENT',
      departmentId: depVentas.id
    },
    {
      name: 'Carlos Ruiz (Ventas)',
      email: 'carlos@ferreteria.com',
      role: 'AGENT',
      departmentId: depVentas.id
    },
    {
      name: 'Sofía Ramírez (Logística)',
      email: 'sofia@ferreteria.com',
      role: 'AGENT',
      departmentId: depSoporte.id
    }
  ];

  for (const u of demoUsers) {
    let user = await prisma.user.findUnique({ where: { email: u.email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          organizationId: org.id,
          name: u.name,
          email: u.email,
          passwordHash: demoPasswordHash,
          role: u.role,
          active: true,
          mustChangePassword: false
        }
      });
      // Asignar al departamento
      await prisma.departmentMember.create({
        data: {
          departmentId: u.departmentId,
          userId: user.id
        }
      });
      console.log(`[seed] ✓ Usuario demo creado: ${user.email} (${user.role})`);
    }
  }

  console.log('[seed] Proceso de inicialización completado con éxito.');
}

main()
  .catch((err) => {
    console.error('[seed] Error:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
