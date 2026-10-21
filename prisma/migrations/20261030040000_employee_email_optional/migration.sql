-- Email on Employee is no longer required — the directory can hold
-- team members (contractors, early hires, etc.) without an email.
-- The unique index stays: Postgres allows multiple NULLs under a
-- unique constraint, so duplicate real addresses are still blocked.
ALTER TABLE "Employee" ALTER COLUMN "email" DROP NOT NULL;
