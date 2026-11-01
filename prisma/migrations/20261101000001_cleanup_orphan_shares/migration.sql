-- One-time cleanup of orphan FileManagerShare rows that point to a
-- folder or file that no longer exists. The resourceId column is a
-- polymorphic (string-only) FK — no DB-level cascade — so historical
-- delete operations left share rows pointing at nothing. New delete
-- paths in the service now sweep these in the same transaction;
-- this migration drops the accumulated backlog.
DELETE FROM "FileManagerShare" s
 WHERE (s."resourceType" = 'FILE'
          AND NOT EXISTS (
            SELECT 1 FROM "FileManagerFile" f WHERE f.id = s."resourceId"
          ))
    OR (s."resourceType" = 'FOLDER'
          AND NOT EXISTS (
            SELECT 1 FROM "FileManagerFolder" f WHERE f.id = s."resourceId"
          ));
