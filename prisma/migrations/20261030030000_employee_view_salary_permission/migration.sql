-- `employees:view_salary` — gates the Salary column in the Employee
-- directory list. Granted to Owner only; Admin Manager and Regular
-- Manager do not get it. Different from `salaries:view` (which gates
-- the dedicated finances pages) because the directory column is a
-- separate, glanceable surface.

INSERT INTO "Permission" (id, key, module, action, label, "createdAt")
VALUES
  (gen_random_uuid(), 'employees:view_salary', 'employees', 'view_salary',
   'View salary numbers in the Employee directory', NOW())
ON CONFLICT (key) DO NOTHING;

-- Grant to Owner only. Admin Manager / Regular Manager stay excluded
-- by omission; the owner can re-grant via the Roles UI if they ever
-- change their mind.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'owner'
  AND p.key = 'employees:view_salary'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
