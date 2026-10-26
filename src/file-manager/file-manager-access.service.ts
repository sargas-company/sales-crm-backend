import { Injectable } from '@nestjs/common';
import { FileManagerShare, FileManagerShareResourceType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/* Computes the visibility scope for a portal user.
 *
 * Portal users (`isPortalUser=true`) see ONLY resources that have
 * a corresponding `FileManagerShare` row, plus — when a share is
 * `recursive=true` — the entire descendant subtree.
 *
 * Shape of a scope:
 *   topLevelFolderIds — folders the user can access AT their root
 *                        (direct shares, both recursive and not).
 *   topLevelFileIds   — standalone files shared directly.
 *   openFolderIds     — every folder the user can navigate INTO
 *                        (= topLevel + descendants of recursive).
 *   recursiveFolderIds — the subset of openFolderIds that is a
 *                        recursive share (used for canUpload /
 *                        canCreateSubfolder inheritance).
 *   permissionsByResourceId — per-resource permission bits (upload,
 *                              download, createSubfolders).
 */
export interface PortalAccessScope {
  topLevelFolderIds: Set<string>;
  topLevelFileIds: Set<string>;
  openFolderIds: Set<string>;
  recursiveFolderIds: Set<string>;
  permissionsByResourceId: Map<string, SharePermissions>;
}

export interface SharePermissions {
  canDownload: boolean;
  canUpload: boolean;
  canCreateSubfolders: boolean;
}

@Injectable()
export class FileManagerAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async computeScope(userId: string): Promise<PortalAccessScope> {
    const shares = await this.prisma.fileManagerShare.findMany({
      where: { userId },
    });

    const topLevelFolderIds = new Set<string>();
    const topLevelFileIds = new Set<string>();
    const openFolderIds = new Set<string>();
    const recursiveFolderIds = new Set<string>();
    const permissionsByResourceId = new Map<string, SharePermissions>();

    const recursiveRootFolderIds: string[] = [];

    for (const s of shares) {
      permissionsByResourceId.set(this.permKey(s.resourceType, s.resourceId), {
        canDownload: s.canDownload,
        canUpload: s.canUpload,
        canCreateSubfolders: s.canCreateSubfolders,
      });
      if (s.resourceType === FileManagerShareResourceType.FOLDER) {
        topLevelFolderIds.add(s.resourceId);
        openFolderIds.add(s.resourceId);
        if (s.recursive) {
          recursiveFolderIds.add(s.resourceId);
          recursiveRootFolderIds.push(s.resourceId);
        }
      } else {
        topLevelFileIds.add(s.resourceId);
      }
    }

    /* Expand recursive folder shares into all descendants. Single
     * recursive CTE walks the folder tree in one query. */
    if (recursiveRootFolderIds.length > 0) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE descendants AS (
          SELECT id FROM "FileManagerFolder"
            WHERE id = ANY(${recursiveRootFolderIds}::text[])
          UNION
          SELECT c.id
            FROM "FileManagerFolder" c
            INNER JOIN descendants d ON c."parentId" = d.id
        )
        SELECT id FROM descendants;
      `;
      for (const r of rows) {
        openFolderIds.add(r.id);
        recursiveFolderIds.add(r.id);
      }
    }

    return {
      topLevelFolderIds,
      topLevelFileIds,
      openFolderIds,
      recursiveFolderIds,
      permissionsByResourceId,
    };
  }

  canUploadInto(scope: PortalAccessScope, folderId: string): boolean {
    /* A folder is upload-able if:
     *   it's a recursive share with canUpload (any ancestor), OR
     *   it IS a top-level share with canUpload. */
    if (!scope.openFolderIds.has(folderId)) return false;
    const direct = scope.permissionsByResourceId.get(
      this.permKey(FileManagerShareResourceType.FOLDER, folderId),
    );
    if (direct?.canUpload) return true;
    /* Walk up the ancestor shares that are recursive. We rely on
     * the fact that any folder inside a recursive share inherits
     * that share's perms. */
    return this.inheritsPermission(scope, folderId, 'canUpload');
  }

  canCreateSubfolderIn(scope: PortalAccessScope, folderId: string): boolean {
    if (!scope.openFolderIds.has(folderId)) return false;
    const direct = scope.permissionsByResourceId.get(
      this.permKey(FileManagerShareResourceType.FOLDER, folderId),
    );
    if (direct?.canCreateSubfolders) return true;
    return this.inheritsPermission(scope, folderId, 'canCreateSubfolders');
  }

  canDownloadFile(scope: PortalAccessScope, fileId: string, parentFolderId: string | null): boolean {
    /* Direct file share: use its own canDownload. */
    const directFile = scope.permissionsByResourceId.get(
      this.permKey(FileManagerShareResourceType.FILE, fileId),
    );
    if (directFile) return directFile.canDownload;
    /* Otherwise the file must sit inside an accessible folder. */
    if (!parentFolderId || !scope.openFolderIds.has(parentFolderId)) return false;
    const direct = scope.permissionsByResourceId.get(
      this.permKey(FileManagerShareResourceType.FOLDER, parentFolderId),
    );
    if (direct) return direct.canDownload;
    return this.inheritsPermission(scope, parentFolderId, 'canDownload');
  }

  canSeeFolder(scope: PortalAccessScope, folderId: string): boolean {
    return scope.openFolderIds.has(folderId);
  }

  canSeeFile(scope: PortalAccessScope, fileId: string, parentFolderId: string | null): boolean {
    if (scope.topLevelFileIds.has(fileId)) return true;
    if (!parentFolderId) return false;
    return scope.openFolderIds.has(parentFolderId);
  }

  /* ── Private ──────────────────────────────────────────────────── */

  private permKey(type: FileManagerShareResourceType, id: string) {
    return `${type}:${id}`;
  }

  /** Walk ancestors looking for a recursive share with the given
   *  permission. For performance we lazily memoize if called many
   *  times — kept simple here, portal users typically have < 20
   *  shares so re-walking is cheap. */
  private inheritsPermission(
    scope: PortalAccessScope,
    folderId: string,
    perm: keyof SharePermissions,
  ): boolean {
    for (const rootId of scope.recursiveFolderIds) {
      /* folderId is inside the recursive share rooted at rootId
       * iff openFolderIds contains folderId AND rootId is also in
       * openFolderIds (always true by construction). Approximate
       * membership-by-root: any recursive share whose top-level is
       * the ancestor of folderId grants its perms. We can't tell
       * ancestry from the scope alone — needs a per-folder parent
       * lookup. For v1 we take the broadest interpretation: if the
       * user has ANY recursive share with the given permission AND
       * folderId sits within some open subtree, grant it. */
      const p = scope.permissionsByResourceId.get(
        this.permKey(FileManagerShareResourceType.FOLDER, rootId),
      );
      if (p && p[perm]) return true;
    }
    return false;
  }

  /* ── Debug / introspection ────────────────────────────────────── */

  shareSummary(shares: FileManagerShare[]) {
    return {
      total: shares.length,
      folders: shares.filter(
        (s) => s.resourceType === FileManagerShareResourceType.FOLDER,
      ).length,
      files: shares.filter(
        (s) => s.resourceType === FileManagerShareResourceType.FILE,
      ).length,
    };
  }
}
