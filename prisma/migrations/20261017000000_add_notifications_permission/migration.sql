-- Add the Notifications permission key so the DB catalogue stays in
-- sync with the seed catalogue after a bare `prisma migrate deploy`.
--
-- `notifications:view` gates the workspace-wide actionable feed
-- served by GET /attention. It is granted to Owner (always carries
-- the full catalogue) and Admin Manager; Regular Manager does NOT
-- receive it, so the frontend hides the Notification Bell and
-- notification pages for that role and direct API hits return 403.

INSERT INTO "Permission" (id, module, action, key, label, "createdAt")
VALUES
    (gen_random_uuid(), 'notifications', 'view', 'notifications:view', 'View workspace notifications and attention feed', now())
ON CONFLICT (key) DO NOTHING;
