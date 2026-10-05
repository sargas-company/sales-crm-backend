-- Add the Project Analytics permission key so the DB catalogue stays
-- in sync with the seed catalogue after a bare `prisma migrate deploy`.

INSERT INTO "Permission" (id, module, action, key, label, "createdAt")
VALUES
    (gen_random_uuid(), 'project_analytics',  'view', 'project_analytics:view',  'View Project Analytics dashboard',  now())
ON CONFLICT (key) DO NOTHING;
