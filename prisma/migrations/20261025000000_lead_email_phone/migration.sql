-- Add optional contact fields on Lead so manager can keep an email
-- and a phone next to the deal without creating a separate Contact
-- entity. Both are nullable; no UNIQUE constraint — the same email
-- or phone may legitimately appear across several leads (same person
-- re-engaging under different deals).

ALTER TABLE "Lead"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "phone" TEXT;
