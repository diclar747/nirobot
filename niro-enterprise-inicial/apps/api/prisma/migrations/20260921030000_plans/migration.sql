CREATE TABLE IF NOT EXISTS "Plan" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "priceGs" INTEGER NOT NULL,
  "maxAgents" INTEGER NOT NULL,
  "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "active" BOOLEAN NOT NULL DEFAULT true,
  "popular" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "planId" TEXT;
ALTER TABLE "Organization" DROP CONSTRAINT IF EXISTS "Organization_planId_fkey";
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingPayment" ADD COLUMN IF NOT EXISTS "planId" TEXT;
ALTER TABLE "BillingPayment" ADD COLUMN IF NOT EXISTS "planName" TEXT;

-- Planes iniciales (el superadmin los puede editar, borrar o sumar otros).
INSERT INTO "Plan" ("id", "name", "description", "priceGs", "maxAgents", "features", "popular", "sortOrder") VALUES
  ('plan-basico',      'Básico',      'Para empezar: vos más 1 agente',            49000,  1,  ARRAY['Sistema completo','1 agente + propietario','CRM, campañas y bot'], false, 1),
  ('plan-estandar',    'Estándar',    'Para equipos chicos: vos más 2 agentes',    80000,  2,  ARRAY['Sistema completo','2 agentes + propietario','CRM, campañas y bot'], true,  2),
  ('plan-manager',     'Manager',     'Para equipos en crecimiento: 5 agentes',    160000, 5,  ARRAY['Sistema completo','5 agentes + propietario','CRM, campañas y bot'], false, 3),
  ('plan-ejecutivo',   'Ejecutivo',   'Para operaciones grandes: 10 agentes',      320000, 10, ARRAY['Sistema completo','10 agentes + propietario','CRM, campañas y bot'], false, 4),
  ('plan-corporativo', 'Corporativo', 'Para empresas: 20 agentes',                 640000, 20, ARRAY['Sistema completo','20 agentes + propietario','CRM, campañas y bot'], false, 5)
ON CONFLICT ("id") DO NOTHING;
