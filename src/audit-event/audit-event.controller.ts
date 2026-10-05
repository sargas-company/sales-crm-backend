import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditResult, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PrismaService } from '../prisma/prisma.service';

class ListAuditEventsDto {
  @IsOptional()
  @IsString()
  domain?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsEnum(AuditResult)
  result?: AuditResult;

  @IsOptional()
  @IsString()
  actorUserId?: string;

  @IsOptional()
  @IsString()
  targetType?: string;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@ApiTags('Audit')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('audit-events')
export class AuditEventController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns a filtered, paginated slice of the AuditEvent stream. The
   * endpoint is intentionally read-only — no update, no delete surface
   * is exposed. For now this is scoped by the `credential_audit:view`
   * permission; a wider "audit:view" guard arrives in Phase 5+ when
   * other domains start writing events.
   */
  @Get()
  @RequirePermission('credential_audit:view')
  @ApiOperation({
    summary:
      'List audit events (append-only, filterable). Sorted newest first.',
  })
  async list(@Query() query: ListAuditEventsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: Prisma.AuditEventWhereInput = {
      ...(query.domain ? { domain: query.domain } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
