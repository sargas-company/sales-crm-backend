import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditResult,
  CredentialAccountStatus,
  Prisma,
} from '@prisma/client';

import { AuditEventService } from '../audit-event/audit-event.service';
import { AuthUser } from '../auth/auth-user';
import { CredentialEncryptionService } from '../credentials-vault/encryption.service';
import { VaultRateLimiterService } from '../credentials-vault/rate-limiter.service';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialChangeNotifierService } from './credential-change-notifier.service';
import { CreateCredentialAccountDto } from './dto/create-account.dto';
import {
  HardDeleteAccountDto,
  UpdateCredentialAccountDto,
} from './dto/update-account.dto';
import { ListCredentialAccountsDto } from './dto/list-accounts.dto';
import { SecretPayloadDto } from './dto/secret-payload.dto';
import { RequestContext } from './credentials-profile.service';

// Safe metadata select — never exposes encPayload / encIv / encAuthTag.
const ACCOUNT_SAFE_SELECT = {
  id: true,
  profileId: true,
  serviceName: true,
  category: true,
  serviceUrl: true,
  iconUrl: true,
  tags: true,
  usernameHint: true,
  status: true,
  lastRotatedAt: true,
  rotationReminderAt: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CredentialAccountSelect;

const HARD_DELETE_KEY = 'credentials:hard_delete';
const REVEAL_LIMIT = 20;
const REVEAL_WINDOW_MS = 60_000;

@Injectable()
export class CredentialsAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: CredentialEncryptionService,
    private readonly audit: AuditEventService,
    private readonly rateLimit: VaultRateLimiterService,
    private readonly notifier: CredentialChangeNotifierService,
  ) {}

  async list(query: ListCredentialAccountsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const where: Prisma.CredentialAccountWhereInput = {
      ...(query.profileId ? { profileId: query.profileId } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { serviceName: { contains: query.search, mode: 'insensitive' } },
              { category: { contains: query.search, mode: 'insensitive' } },
              { tags: { has: query.search.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.credentialAccount.findMany({
        where,
        select: ACCOUNT_SAFE_SELECT,
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.credentialAccount.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async getOne(id: string) {
    const account = await this.prisma.credentialAccount.findUnique({
      where: { id },
      select: ACCOUNT_SAFE_SELECT,
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  async create(dto: CreateCredentialAccountDto, actor: AuthUser, context: RequestContext) {
    const profile = await this.prisma.credentialProfile.findUnique({
      where: { id: dto.profileId },
      select: { id: true, name: true },
    });
    if (!profile) throw new BadRequestException('profileId does not match a profile');

    const enc = this.enc.encryptJson(this.sanitizePayload(dto.secrets));
    const account = await this.prisma.credentialAccount.create({
      data: {
        profileId: dto.profileId,
        serviceName: dto.serviceName,
        category: dto.category,
        serviceUrl: dto.serviceUrl ?? null,
        iconUrl: dto.iconUrl ?? null,
        tags: dto.tags ?? [],
        usernameHint: dto.usernameHint ?? null,
        status: CredentialAccountStatus.ACTIVE,
        encPayload: enc.ciphertext,
        encIv: enc.iv,
        encAuthTag: enc.authTag,
        encKeyVersion: enc.keyVersion,
        encAlgorithm: enc.algorithm,
        lastRotatedAt: dto.lastRotatedAt ? new Date(dto.lastRotatedAt) : new Date(),
        rotationReminderAt: dto.rotationReminderAt ? new Date(dto.rotationReminderAt) : null,
        createdById: actor.id,
        updatedById: actor.id,
      },
      select: ACCOUNT_SAFE_SELECT,
    });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'account.create',
      targetType: 'CredentialAccount',
      targetId: account.id,
      targetLabel: `${profile.name} · ${account.serviceName}`,
      result: AuditResult.SUCCESS,
      metadata: { category: account.category, secretFields: this.describeShape(dto.secrets) },
      ...context,
    });
    return account;
  }

  async update(id: string, dto: UpdateCredentialAccountDto, actor: AuthUser, context: RequestContext) {
    const existing = await this.prisma.credentialAccount.findUnique({
      where: { id },
      select: {
        id: true,
        serviceName: true,
        serviceUrl: true,
        profile: { select: { name: true } },
        encPayload: true,
        encIv: true,
        encAuthTag: true,
        encKeyVersion: true,
        encAlgorithm: true,
      },
    });
    if (!existing) throw new NotFoundException('Account not found');

    // Which secret keys actually changed (null/'' is treated as "unset").
    // Driven off the decrypted previous payload so we can report a
    // concrete field list on Discord without ever shipping values.
    let previous: SecretPayloadDto = {};
    try {
      previous = this.enc.decryptJson<SecretPayloadDto>({
        ciphertext: existing.encPayload,
        iv: existing.encIv,
        authTag: existing.encAuthTag,
        keyVersion: existing.encKeyVersion,
        algorithm: existing.encAlgorithm,
      });
    } catch {
      previous = {};
    }

    let encFields: Prisma.CredentialAccountUpdateInput = {};
    let secretChanged = false;
    const changedSecretKeys: string[] = [];
    if (dto.secrets) {
      // Merge — keep the fields the caller did not pass so a partial
      // update never wipes the whole payload.
      const merged = this.sanitizePayload({ ...previous, ...dto.secrets });
      changedSecretKeys.push(...diffSecretKeys(previous, merged));
      secretChanged = changedSecretKeys.length > 0;
      if (secretChanged) {
        const enc = this.enc.encryptJson(merged);
        encFields = {
          encPayload: enc.ciphertext,
          encIv: enc.iv,
          encAuthTag: enc.authTag,
          encKeyVersion: enc.keyVersion,
          encAlgorithm: enc.algorithm,
          lastRotatedAt: new Date(),
        };
      }
    }

    // Snapshot the OLD encrypted payload BEFORE write, but only when
    // we are actually about to change it — avoids history noise from
    // metadata-only edits.
    if (secretChanged) {
      await this.prisma.credentialSecretVersion.create({
        data: {
          accountId: existing.id,
          changedById: actor.id,
          changeReason: 'edit',
          encPayload: existing.encPayload,
          encIv: existing.encIv,
          encAuthTag: existing.encAuthTag,
          encKeyVersion: existing.encKeyVersion,
          encAlgorithm: existing.encAlgorithm,
        },
      });
    }

    // Metadata-field diff: compare dto value to the live row value.
    // serviceUrl is nullable, treat null and '' as "unset" for parity
    // with the UI.
    const changedMetaKeys: string[] = [];
    if (
      dto.serviceName !== undefined &&
      dto.serviceName !== existing.serviceName
    ) {
      changedMetaKeys.push('serviceName');
    }
    if (
      dto.serviceUrl !== undefined &&
      (dto.serviceUrl ?? null) !== (existing.serviceUrl ?? null)
    ) {
      changedMetaKeys.push('serviceUrl');
    }

    const updated = await this.prisma.credentialAccount.update({
      where: { id },
      data: {
        ...(dto.serviceName !== undefined ? { serviceName: dto.serviceName } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.serviceUrl !== undefined ? { serviceUrl: dto.serviceUrl ?? null } : {}),
        ...(dto.iconUrl !== undefined ? { iconUrl: dto.iconUrl ?? null } : {}),
        ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
        ...(dto.usernameHint !== undefined ? { usernameHint: dto.usernameHint ?? null } : {}),
        ...(dto.rotationReminderAt !== undefined
          ? { rotationReminderAt: dto.rotationReminderAt ? new Date(dto.rotationReminderAt) : null }
          : {}),
        ...(dto.lastRotatedAt !== undefined
          ? { lastRotatedAt: dto.lastRotatedAt ? new Date(dto.lastRotatedAt) : null }
          : {}),
        ...encFields,
        updatedById: actor.id,
      },
      select: ACCOUNT_SAFE_SELECT,
    });

    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'account.update',
      targetType: 'CredentialAccount',
      targetId: updated.id,
      targetLabel: `${existing.profile.name} · ${updated.serviceName}`,
      result: AuditResult.SUCCESS,
      metadata: {
        changedFields: [...changedMetaKeys, ...changedSecretKeys],
        secretChanged,
      },
      ...context,
    });

    // Discord notification — only when a SECRET field actually changed.
    // Metadata-only edits (serviceName rename, URL/icon/tags) are
    // intentionally silent: they also don't create a history version,
    // so firing a notification for them would be inconsistent and
    // noisy. Audit log still records every change.
    if (secretChanged) {
      void this.notifier.notify({
        kind: 'account_updated',
        profileName: existing.profile.name,
        serviceName: updated.serviceName,
        changedFields: changedSecretKeys,
        actorUserId: actor.id,
      });
    }
    return updated;
  }

  async archive(id: string, actor: AuthUser, context: RequestContext) {
    const existing = await this.prisma.credentialAccount.findUnique({
      where: { id },
      select: { id: true, serviceName: true, status: true, profile: { select: { name: true } } },
    });
    if (!existing) throw new NotFoundException('Account not found');
    if (existing.status === CredentialAccountStatus.ARCHIVED) {
      return this.getOne(id);
    }
    const updated = await this.prisma.credentialAccount.update({
      where: { id },
      data: { status: CredentialAccountStatus.ARCHIVED, updatedById: actor.id },
      select: ACCOUNT_SAFE_SELECT,
    });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'account.archive',
      targetType: 'CredentialAccount',
      targetId: updated.id,
      targetLabel: `${existing.profile.name} · ${updated.serviceName}`,
      result: AuditResult.SUCCESS,
      ...context,
    });
    return updated;
  }

  async restore(id: string, actor: AuthUser, context: RequestContext) {
    const existing = await this.prisma.credentialAccount.findUnique({
      where: { id },
      select: { id: true, serviceName: true, profile: { select: { name: true } } },
    });
    if (!existing) throw new NotFoundException('Account not found');
    const updated = await this.prisma.credentialAccount.update({
      where: { id },
      data: { status: CredentialAccountStatus.ACTIVE, updatedById: actor.id },
      select: ACCOUNT_SAFE_SELECT,
    });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'account.restore',
      targetType: 'CredentialAccount',
      targetId: updated.id,
      targetLabel: `${existing.profile.name} · ${updated.serviceName}`,
      result: AuditResult.SUCCESS,
      ...context,
    });
    return updated;
  }

  async hardDelete(
    id: string,
    dto: HardDeleteAccountDto,
    actor: AuthUser,
    context: RequestContext,
  ) {
    if (!actor.permissions.has(HARD_DELETE_KEY)) {
      await this.audit.record({
        actorUserId: actor.id,
        domain: 'credentials',
        action: 'account.hard_delete',
        targetType: 'CredentialAccount',
        targetId: id,
        result: AuditResult.DENIED,
        metadata: { reason: 'missing credentials:hard_delete' },
        ...context,
      });
      throw new ForbiddenException('Hard delete requires credentials:hard_delete.');
    }
    const existing = await this.prisma.credentialAccount.findUnique({
      where: { id },
      select: {
        id: true,
        serviceName: true,
        profile: { select: { name: true } },
      },
    });
    if (!existing) throw new NotFoundException('Account not found');
    if (dto.confirmation !== existing.serviceName) {
      await this.audit.record({
        actorUserId: actor.id,
        domain: 'credentials',
        action: 'account.hard_delete',
        targetType: 'CredentialAccount',
        targetId: existing.id,
        targetLabel: `${existing.profile.name} · ${existing.serviceName}`,
        result: AuditResult.DENIED,
        metadata: { reason: 'confirmation mismatch' },
        ...context,
      });
      throw new BadRequestException('Confirmation does not match serviceName.');
    }
    await this.prisma.credentialAccount.delete({ where: { id } });
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'account.hard_delete',
      targetType: 'CredentialAccount',
      targetId: existing.id,
      targetLabel: `${existing.profile.name} · ${existing.serviceName}`,
      result: AuditResult.SUCCESS,
      ...context,
    });
    void this.notifier.notify({
      kind: 'account_hard_deleted',
      profileName: existing.profile.name,
      serviceName: existing.serviceName,
      actorUserId: actor.id,
    });
    return { id: existing.id };
  }

  /**
   * Decrypt and return the secret payload. Phase 3 will insert a
   * vault-session check before this method is reached; today the caller
   * is authenticated + carries `credentials:reveal`. Response must be
   * used with `Cache-Control: no-store` at the HTTP layer.
   */
  async reveal(id: string, actor: AuthUser, context: RequestContext) {
    this.rateLimit.consume('vault.reveal', actor.id, REVEAL_LIMIT, REVEAL_WINDOW_MS);
    const row = await this.prisma.credentialAccount.findUnique({
      where: { id },
      select: {
        id: true,
        serviceName: true,
        profile: { select: { name: true } },
        encPayload: true,
        encIv: true,
        encAuthTag: true,
        encKeyVersion: true,
        encAlgorithm: true,
      },
    });
    if (!row) {
      await this.audit.record({
        actorUserId: actor.id,
        domain: 'credentials',
        action: 'account.reveal',
        targetType: 'CredentialAccount',
        targetId: id,
        result: AuditResult.FAILED,
        metadata: { reason: 'not_found' },
        ...context,
      });
      throw new NotFoundException('Account not found');
    }
    let secrets: SecretPayloadDto;
    try {
      secrets = this.enc.decryptJson<SecretPayloadDto>({
        ciphertext: row.encPayload,
        iv: row.encIv,
        authTag: row.encAuthTag,
        keyVersion: row.encKeyVersion,
        algorithm: row.encAlgorithm,
      });
    } catch (err) {
      await this.audit.record({
        actorUserId: actor.id,
        domain: 'credentials',
        action: 'account.reveal',
        targetType: 'CredentialAccount',
        targetId: row.id,
        targetLabel: `${row.profile.name} · ${row.serviceName}`,
        result: AuditResult.FAILED,
        metadata: { reason: 'decrypt_failed' },
        ...context,
      });
      throw err;
    }
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'account.reveal',
      targetType: 'CredentialAccount',
      targetId: row.id,
      targetLabel: `${row.profile.name} · ${row.serviceName}`,
      result: AuditResult.SUCCESS,
      metadata: { fields: this.describeShape(secrets) },
      ...context,
    });
    return {
      id: row.id,
      serviceName: row.serviceName,
      secrets,
    };
  }

  /**
   * Best-effort audit note for copy actions. The endpoint takes a field
   * name (e.g. 'password', 'totp', 'recoveryCode:2') and writes an audit
   * row — no secret value ever touches the log. Used by the reveal UI.
   */
  async recordCopy(
    accountId: string,
    field: string,
    actor: AuthUser,
    context: RequestContext,
  ) {
    const row = await this.prisma.credentialAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        serviceName: true,
        profile: { select: { name: true } },
      },
    });
    if (!row) throw new NotFoundException('Account not found');
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'account.copy',
      targetType: 'CredentialAccount',
      targetId: row.id,
      targetLabel: `${row.profile.name} · ${row.serviceName}`,
      result: AuditResult.SUCCESS,
      metadata: { field: this.safeFieldLabel(field) },
      ...context,
    });
  }

  private sanitizePayload(input: SecretPayloadDto): SecretPayloadDto {
    // Strip empty strings so a payload can shrink; keep only meaningful values.
    const out: SecretPayloadDto = {};
    if (input.username) out.username = input.username;
    if (input.email) out.email = input.email;
    if (input.password) out.password = input.password;
    if (input.totpSeed) out.totpSeed = input.totpSeed.replace(/\s+/g, '').toUpperCase();
    if (input.recoveryCodes && input.recoveryCodes.length) out.recoveryCodes = input.recoveryCodes;
    if (input.pin) out.pin = input.pin;
    if (input.securityAnswers && input.securityAnswers.length) out.securityAnswers = input.securityAnswers;
    if (input.secureNote) out.secureNote = input.secureNote;
    if (input.customFields && input.customFields.length) {
      out.customFields = input.customFields
        .filter((f) => f.label?.trim() && f.value !== undefined)
        .slice(0, 32);
    }
    return out;
  }

  private describeShape(payload: SecretPayloadDto): string[] {
    // Audit-safe: never values, only the fields that were present.
    const shape: string[] = [];
    if (payload.username) shape.push('username');
    if (payload.email) shape.push('email');
    if (payload.password) shape.push('password');
    if (payload.totpSeed) shape.push('totpSeed');
    if (payload.recoveryCodes?.length) shape.push(`recoveryCodes[${payload.recoveryCodes.length}]`);
    if (payload.pin) shape.push('pin');
    if (payload.securityAnswers?.length) shape.push(`securityAnswers[${payload.securityAnswers.length}]`);
    if (payload.secureNote) shape.push('secureNote');
    if (payload.customFields?.length) shape.push(`customFields[${payload.customFields.length}]`);
    return shape;
  }

  private safeFieldLabel(raw: string): string {
    // Trim, cap at 40 chars; strip anything unfriendly. Never a value.
    return raw.replace(/[^\w:.\-\[\]]/g, '').slice(0, 40);
  }

  // ─── History ────────────────────────────────────────────────────

  /**
   * List version metadata for an account newest-first. NEVER returns
   * decrypted data — only who/when/why. Decrypting a specific version
   * goes through `revealVersion()`, which is gated by the vault session
   * + `credentials:reveal` permission (no additional per-call MFA
   * step-up — see `work/standards/decisions.md` § Credentials vault —
   * session gating).
   */
  async listVersions(accountId: string) {
    const account = await this.prisma.credentialAccount.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    const rows = await this.prisma.credentialSecretVersion.findMany({
      where: { accountId },
      orderBy: { changedAt: 'desc' },
      select: {
        id: true,
        changedAt: true,
        changedById: true,
        changeReason: true,
      },
      take: 200,
    });
    const actorIds = Array.from(
      new Set(rows.map((r) => r.changedById).filter((v): v is string => !!v)),
    );
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true, firstName: true, lastName: true },
        })
      : [];
    const byId = new Map(actors.map((u) => [u.id, u]));
    return {
      data: rows.map((r) => {
        const actor = r.changedById ? byId.get(r.changedById) : null;
        return {
          id: r.id,
          changedAt: r.changedAt,
          changeReason: r.changeReason,
          changedBy: actor
            ? {
                id: actor.id,
                email: actor.email,
                name: `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim(),
              }
            : null,
        };
      }),
    };
  }

  /**
   * Decrypt + return a historic version's secrets. Rate-limited per
   * caller (shares the same bucket as regular reveal — fresh TOTP /
   * passkey already enforced at the controller level). Audit-logged.
   */
  async revealVersion(
    accountId: string,
    versionId: string,
    actor: AuthUser,
    context: RequestContext,
  ) {
    this.rateLimit.consume('vault.reveal', actor.id, REVEAL_LIMIT, REVEAL_WINDOW_MS);
    const row = await this.prisma.credentialSecretVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        accountId: true,
        encPayload: true,
        encIv: true,
        encAuthTag: true,
        encKeyVersion: true,
        encAlgorithm: true,
        account: {
          select: {
            id: true,
            serviceName: true,
            profile: { select: { name: true } },
          },
        },
      },
    });
    if (!row || row.accountId !== accountId) {
      throw new NotFoundException('Version not found');
    }
    let secrets: SecretPayloadDto;
    try {
      secrets = this.enc.decryptJson<SecretPayloadDto>({
        ciphertext: row.encPayload,
        iv: row.encIv,
        authTag: row.encAuthTag,
        keyVersion: row.encKeyVersion,
        algorithm: row.encAlgorithm,
      });
    } catch (err) {
      await this.audit.record({
        actorUserId: actor.id,
        domain: 'credentials',
        action: 'account.history.reveal',
        targetType: 'CredentialSecretVersion',
        targetId: row.id,
        targetLabel: `${row.account.profile.name} · ${row.account.serviceName}`,
        result: AuditResult.FAILED,
        metadata: { reason: 'decrypt_failed' },
        ...context,
      });
      throw err;
    }
    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'account.history.reveal',
      targetType: 'CredentialSecretVersion',
      targetId: row.id,
      targetLabel: `${row.account.profile.name} · ${row.account.serviceName}`,
      result: AuditResult.SUCCESS,
      metadata: { fields: this.describeShape(secrets) },
      ...context,
    });
    return { id: row.id, secrets };
  }

  /**
   * Replace the live encPayload with a historical snapshot. Before
   * writing, snapshot the current live value as a NEW version row
   * tagged `restore` — so restore itself remains reversible. Fires
   * Discord notif + audit. Does not touch metadata (serviceName etc.).
   */
  async restoreVersion(
    accountId: string,
    versionId: string,
    actor: AuthUser,
    context: RequestContext,
  ) {
    const [account, version] = await Promise.all([
      this.prisma.credentialAccount.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          serviceName: true,
          profile: { select: { name: true } },
          encPayload: true,
          encIv: true,
          encAuthTag: true,
          encKeyVersion: true,
          encAlgorithm: true,
        },
      }),
      this.prisma.credentialSecretVersion.findUnique({
        where: { id: versionId },
        select: {
          id: true,
          accountId: true,
          encPayload: true,
          encIv: true,
          encAuthTag: true,
          encKeyVersion: true,
          encAlgorithm: true,
        },
      }),
    ]);
    if (!account) throw new NotFoundException('Account not found');
    if (!version || version.accountId !== accountId) {
      throw new NotFoundException('Version not found');
    }

    // Snapshot CURRENT state first (so restore is itself reversible).
    await this.prisma.credentialSecretVersion.create({
      data: {
        accountId: account.id,
        changedById: actor.id,
        changeReason: 'restore',
        encPayload: account.encPayload,
        encIv: account.encIv,
        encAuthTag: account.encAuthTag,
        encKeyVersion: account.encKeyVersion,
        encAlgorithm: account.encAlgorithm,
      },
    });

    const updated = await this.prisma.credentialAccount.update({
      where: { id: account.id },
      data: {
        encPayload: version.encPayload,
        encIv: version.encIv,
        encAuthTag: version.encAuthTag,
        encKeyVersion: version.encKeyVersion,
        encAlgorithm: version.encAlgorithm,
        updatedById: actor.id,
        lastRotatedAt: new Date(),
      },
      select: ACCOUNT_SAFE_SELECT,
    });

    await this.audit.record({
      actorUserId: actor.id,
      domain: 'credentials',
      action: 'account.history.restore',
      targetType: 'CredentialAccount',
      targetId: account.id,
      targetLabel: `${account.profile.name} · ${account.serviceName}`,
      result: AuditResult.SUCCESS,
      metadata: { restoredFromVersionId: version.id },
      ...context,
    });

    void this.notifier.notify({
      kind: 'account_restored',
      profileName: account.profile.name,
      serviceName: account.serviceName,
      actorUserId: actor.id,
    });

    return updated;
  }
}

/**
 * Diff two decrypted SecretPayload values, returning the list of
 * KEY names that actually changed (never values). Empty-string and
 * absent are treated as the same "unset" state for parity with the
 * UI, which never distinguishes "" from undefined. CustomFields are
 * compared by (label, value) pair under a `custom:{label}` key so
 * added/removed/renamed/edited rows all surface distinctly.
 */
function diffSecretKeys(
  before: SecretPayloadDto,
  after: SecretPayloadDto,
): string[] {
  const changed: string[] = [];
  const scalarKeys = [
    'username',
    'email',
    'password',
    'totpSeed',
    'pin',
    'secureNote',
  ] as const;
  for (const k of scalarKeys) {
    const a = ((before[k] as string | undefined) ?? '').trim();
    const b = ((after[k] as string | undefined) ?? '').trim();
    if (a !== b) changed.push(k);
  }
  // Recovery codes: compare normalised join.
  const prevRec = (before.recoveryCodes ?? []).map((s) => s.trim()).join('|');
  const nextRec = (after.recoveryCodes ?? []).map((s) => s.trim()).join('|');
  if (prevRec !== nextRec) changed.push('recoveryCodes');
  // Custom fields: compare as a sorted (label|value) multiset.
  const asBag = (list: Array<{ label: string; value: string }> | undefined) =>
    (list ?? [])
      .map((f) => `${f.label.trim()}=${f.value.trim()}`)
      .sort()
      .join('\n');
  if (asBag(before.customFields) !== asBag(after.customFields)) {
    changed.push('customFields');
  }
  return changed;
}
