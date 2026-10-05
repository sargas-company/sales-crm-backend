/* eslint-disable @typescript-eslint/no-var-requires */
import 'reflect-metadata';
import { describe, it, expect } from '@jest/globals';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';

import { AppModule } from '../app.module';
import { REQUIRED_PERMISSIONS_KEY } from './permission.decorator';

// Every route handler exposed by AppModule MUST be classified as
// exactly one of:
//   • authenticated + @RequirePermission(...) (RBAC-gated),
//   • authenticated-only              (JWT-only, whitelisted below),
//   • public                          (no auth, whitelisted below).
//
// A regression that adds a new business endpoint without permission
// decorator (or forgets the JWT guard entirely) will fail this test.
//
// The whitelist is deliberately small; every route on it needs a
// human reason.

interface RouteInfo {
  controller: string;
  method: string;
  routeKey: string;
  hasJwtGuard: boolean;
  hasPermissionGuard: boolean;
  hasRequirePermission: boolean;
  hasRolesGuard: boolean;
  hasPublicMarker: boolean;
}

// Public endpoints (no JWT, no permission gate). Every entry is
// present for a spelled-out reason.
const PUBLIC_ALLOWLIST = new Set<string>([
  // Public authentication endpoints.
  'AuthController#login',
  'AuthController#refresh',
  // Health probe for load balancers / uptime checks.
  'HealthController#check',
  // Inbound landing-page form → intentionally open.
  'ClientRequestsController#create',
  // Vibe Worker webhook is protected by its own shared-secret guard.
  'VibeWorkerWebhookController#captureJobPost',
  // Discord Interactions endpoint. Protected by per-request Ed25519
  // signature verification against DISCORD_PUBLIC_KEY — the signed
  // raw body IS the authorization check, so JWT is not applicable.
  'DiscordInteractionsController#handle',
]);

// Authenticated-but-not-RBAC-gated endpoints. Entries here must act
// exclusively on the caller's own session or on a workspace-wide
// surface that every authenticated user is explicitly expected to
// see. No endpoint that mutates another user's data or returns a
// per-permission filtered projection belongs here.
const AUTH_ONLY_ALLOWLIST = new Set<string>([
  'AuthController#logout',
  'AuthController#me',
  // Avatar self-service — every handler reads/writes only
  // `req.user.id`'s own User row and avatar storage key. There is
  // no admin-view permission for avatars; the self-only invariant
  // comes from the implementation using the authenticated user id
  // as the sole subject.
  'AuthController#updateMe',
  'AuthController#uploadAvatar',
  'AuthController#listAvatarPresets',
  'AuthController#setAvatarPreset',
  'AuthController#deleteAvatar',
]);

const getGuards = (target: object): unknown[] => {
  const key = '__guards__';
  const list = Reflect.getMetadata(key, target) as unknown[] | undefined;
  return list ?? [];
};

const guardName = (g: unknown): string => {
  if (!g) return '';
  if (typeof g === 'function') return (g as { name?: string }).name ?? '';
  const ctor = (g as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? '';
};

const guardsInclude = (guards: unknown[], name: string): boolean =>
  guards.some((g) => guardName(g) === name);

const scanRoutes = async (): Promise<RouteInfo[]> => {
  // Import controllers via the compiled AppModule metadata.
  const routes: RouteInfo[] = [];
  const moduleMetadata = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
  // Walk AppModule.controllers and every imported module's controllers.
  const controllers: Array<new (...args: unknown[]) => object> = [];
  const collect = (mod: unknown) => {
    if (!mod || typeof mod !== 'object' && typeof mod !== 'function') return;
    const ctrls = Reflect.getMetadata('controllers', mod as object) as
      | Array<new (...args: unknown[]) => object>
      | undefined;
    if (ctrls) controllers.push(...ctrls);
  };
  collect(AppModule);
  for (const mod of moduleMetadata) collect(mod);

  for (const controller of controllers) {
    const classGuards = getGuards(controller);
    const classPerms = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      controller,
    ) as string[] | undefined;
    const proto = controller.prototype as Record<string, unknown>;

    for (const methodName of Object.getOwnPropertyNames(proto)) {
      if (methodName === 'constructor') continue;
      const handler = proto[methodName];
      if (typeof handler !== 'function') continue;
      const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler);
      // Handlers without a HTTP-method decorator are helpers, not routes.
      if (httpMethod === undefined) continue;
      const pathMeta = Reflect.getMetadata(PATH_METADATA, handler);
      const methodGuards = getGuards(handler);
      const allGuards = [...classGuards, ...methodGuards];
      const methodPerms = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        handler,
      ) as string[] | undefined;
      const perms = methodPerms ?? classPerms;

      routes.push({
        controller: controller.name,
        method: methodName,
        routeKey: `${controller.name}#${methodName}`,
        hasJwtGuard: guardsInclude(allGuards, 'JwtAuthGuard'),
        hasPermissionGuard: guardsInclude(allGuards, 'PermissionGuard'),
        hasRequirePermission: Array.isArray(perms) && perms.length > 0,
        hasRolesGuard: guardsInclude(allGuards, 'RolesGuard'),
        hasPublicMarker: PUBLIC_ALLOWLIST.has(
          `${controller.name}#${methodName}`,
        ),
      });
      // Silence unused-var warning for pathMeta while keeping the read.
      void pathMeta;
    }
  }

  return routes;
};

describe('Authorization contract', () => {
  it('every route is classified as public, authenticated-only, or RBAC-gated', async () => {
    const routes = await scanRoutes();
    expect(routes.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const r of routes) {
      const isPublic = PUBLIC_ALLOWLIST.has(r.routeKey);
      const isAuthOnly = AUTH_ONLY_ALLOWLIST.has(r.routeKey);

      if (isPublic) {
        // Must NOT have JWT or Permission or Roles guard on the
        // handler chain.
        if (r.hasJwtGuard || r.hasPermissionGuard) {
          violations.push(
            `${r.routeKey}: on PUBLIC allowlist but has JWT/Permission guard`,
          );
        }
        continue;
      }

      if (!r.hasJwtGuard) {
        violations.push(
          `${r.routeKey}: not on public allowlist and has no JwtAuthGuard`,
        );
        continue;
      }

      if (isAuthOnly) {
        // Must be authenticated-only. Any @RequirePermission or
        // PermissionGuard here is a mismatch.
        if (r.hasRequirePermission || r.hasPermissionGuard) {
          violations.push(
            `${r.routeKey}: on AUTH_ONLY allowlist but has permission guard`,
          );
        }
        continue;
      }

      // Every other authenticated route must carry
      // @RequirePermission via PermissionGuard.
      if (!r.hasPermissionGuard || !r.hasRequirePermission) {
        violations.push(
          `${r.routeKey}: authenticated but missing @RequirePermission / PermissionGuard`,
        );
      }
    }

    if (violations.length) {
      // Surface every miss at once so the developer can fix them together.
      throw new Error(
        `Authorization contract violated:\n  ${violations.join('\n  ')}`,
      );
    }
  });

  it('legacy RolesGuard is no longer used on any live route', async () => {
    const routes = await scanRoutes();
    const legacy = routes.filter((r) => r.hasRolesGuard);
    expect(legacy.map((r) => r.routeKey)).toEqual([]);
  });
});
