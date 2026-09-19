-- Persisted visual bot flow per organization. The JSON shape is validated by the API
-- so each SaaS tenant keeps an isolated, versioned automation graph.
ALTER TABLE "OrganizationSettings"
  ADD COLUMN "botFlow" JSONB NOT NULL DEFAULT '{}'::jsonb;
