-- Drop UpworkProfile.title entirely. Identity is `firstName +
-- lastName` from here on; the seed and all backend code match
-- profiles by that pair.

ALTER TABLE "UpworkProfile" DROP COLUMN "title";
