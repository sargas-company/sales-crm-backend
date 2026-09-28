-- Drop the legacy `User.role` shadow column and the `UserRole` enum.
--
-- After this pass, no runtime code and no seed line reads or writes
-- either object:
--   • Settings controller was migrated from `@Roles(UserRole.ADMIN)`
--     to `@RequirePermission('settings:view' / 'settings:update')`.
--   • `RolesGuard` and `roles.decorator.ts` have been deleted; the
--     authorization-contract spec asserts that no route lists
--     `RolesGuard` in its guard chain.
--   • `prisma/seed.ts` no longer sets `role: UserRole.*` on the
--     seeded users.
--
-- The column is nullable and carries no FK, so dropping it discards
-- only the pre-migration enum value on each row; nothing else is
-- affected. The enum has no other consumers in the schema.

ALTER TABLE "User" DROP COLUMN "role";
DROP TYPE "UserRole";
