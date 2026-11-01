-- Folder shares are now always recursive. The `recursive` column stays
-- on the model for backwards compat (safer rollback) but the backend
-- ignores it — every folder share expands to all descendants. Flip
-- any existing non-recursive folder-share rows to true so visible
-- state matches the new behavior.
UPDATE "FileManagerShare"
   SET "recursive" = true
 WHERE "resourceType" = 'FOLDER'
   AND "recursive" = false;
