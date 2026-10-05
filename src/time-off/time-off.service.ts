import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TimeOff, TimeOffType } from '@prisma/client';

import { AuthUser } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import { CreateTimeOffDto } from './dto/create-time-off.dto';
import {
  ListTimeOffDto,
  TimeOffSortBy,
  TimeOffSortDirection,
} from './dto/list-time-off.dto';
import { UpdateTimeOffDto } from './dto/update-time-off.dto';

// Fallback annual allowances per employee (working days). Live values
// come from Settings; these constants are used only if the Setting is
// missing or unreadable.
const VACATION_ALLOWANCE = 21;
const SICK_LEAVE_ALLOWANCE = 5;

@Injectable()
export class TimeOffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  private async getPolicy() {
    const [vacation, sick, weekdaysRaw, allowNegative] = await Promise.all([
      this.settings.getNumberForKey(
        SK.TIMEOFF_VACATION_DAYS_PER_YEAR,
        VACATION_ALLOWANCE,
      ),
      this.settings.getNumberForKey(
        SK.TIMEOFF_SICK_DAYS_PER_YEAR,
        SICK_LEAVE_ALLOWANCE,
      ),
      this.settings.getValueForKey(SK.TIMEOFF_WORKING_WEEKDAYS),
      this.settings.getBooleanForKey(
        SK.TIMEOFF_ALLOW_NEGATIVE_BALANCE,
        true,
      ),
    ]);
    const workingWeekdays = Array.isArray(weekdaysRaw)
      ? (weekdaysRaw as number[]).map((n) => Number(n)).filter((n) => Number.isInteger(n))
      : [1, 2, 3, 4, 5];
    return {
      vacationAllowance: vacation,
      sickAllowance: sick,
      workingWeekdays: new Set(workingWeekdays),
      allowNegativeBalance: allowNegative,
    };
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────

  async create(dto: CreateTimeOffDto, user: AuthUser) {
    const start = this.parseDay(dto.startDate);
    const end = this.parseDay(dto.endDate);
    this.assertRangeValid(start, end);
    await this.assertEmployeeExists(dto.employeeId);
    await this.assertNoOverlap(dto.employeeId, start, end);
    const policy = await this.getPolicy();
    await this.assertWithinAllowance(
      dto.employeeId,
      dto.type,
      start,
      end,
      undefined,
      policy,
    );

    const workingDays = this.workingDaysBetween(start, end, policy.workingWeekdays);
    try {
      return await this.prisma.timeOff.create({
        data: {
          employeeId: dto.employeeId,
          type: dto.type,
          startDate: start,
          endDate: end,
          workingDays,
          note: dto.note,
          createdById: user.id,
        },
        include: this.include(),
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  async findAll(dto: ListTimeOffDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? TimeOffSortDirection.desc;

    const where: Prisma.TimeOffWhereInput = {
      AND: [
        dto.type ? { type: dto.type } : {},
        dto.employeeId ? { employeeId: dto.employeeId } : {},
        dto.year
          ? {
              startDate: { lte: new Date(Date.UTC(dto.year, 11, 31)) },
              endDate: { gte: new Date(Date.UTC(dto.year, 0, 1)) },
            }
          : {},
        dto.from ? { endDate: { gte: this.parseDay(dto.from) } } : {},
        dto.to ? { startDate: { lte: this.parseDay(dto.to) } } : {},
        dto.search
          ? {
              OR: [
                {
                  employee: {
                    firstName: { contains: dto.search, mode: 'insensitive' },
                  },
                },
                {
                  employee: {
                    lastName: { contains: dto.search, mode: 'insensitive' },
                  },
                },
                { note: { contains: dto.search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };

    const [data, total] = await Promise.all([
      this.prisma.timeOff.findMany({
        where,
        orderBy: this.buildOrderBy(dto.sortBy, dir),
        skip: offset,
        take: limit,
        include: this.include(),
      }),
      this.prisma.timeOff.count({ where }),
    ]);
    return { data, total };
  }

  async findOne(id: string) {
    const row = await this.prisma.timeOff.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!row) throw new NotFoundException('Time-off record not found');
    return row;
  }

  async update(id: string, dto: UpdateTimeOffDto) {
    const existing = await this.prisma.timeOff.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Time-off record not found');

    const nextEmployeeId = dto.employeeId ?? existing.employeeId;
    const nextType = (dto.type ?? existing.type) as TimeOffType;
    const nextStart = dto.startDate
      ? this.parseDay(dto.startDate)
      : existing.startDate;
    const nextEnd = dto.endDate ? this.parseDay(dto.endDate) : existing.endDate;
    this.assertRangeValid(nextStart, nextEnd);

    if (nextEmployeeId !== existing.employeeId) {
      await this.assertEmployeeExists(nextEmployeeId);
    }
    await this.assertNoOverlap(nextEmployeeId, nextStart, nextEnd, id);
    const policy = await this.getPolicy();
    await this.assertWithinAllowance(
      nextEmployeeId,
      nextType,
      nextStart,
      nextEnd,
      id,
      policy,
    );
    const workingDays = this.workingDaysBetween(
      nextStart,
      nextEnd,
      policy.workingWeekdays,
    );

    try {
      return await this.prisma.timeOff.update({
        where: { id },
        data: {
          employeeId: nextEmployeeId,
          type: nextType,
          startDate: nextStart,
          endDate: nextEnd,
          workingDays,
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
        include: this.include(),
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  async remove(id: string) {
    const existing = await this.prisma.timeOff.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Time-off record not found');
    await this.prisma.timeOff.delete({ where: { id } });
  }

  // ─── Summary (KPIs) ────────────────────────────────────────────────────

  async summary(year: number, referenceDate: Date = new Date()) {
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const today = this.toUtcDate(referenceDate);
    const in30 = new Date(today);
    in30.setUTCDate(in30.getUTCDate() + 30);

    const [outToday, upcoming, vacRows, sickRows] = await Promise.all([
      this.prisma.timeOff.count({
        where: {
          startDate: { lte: today },
          endDate: { gte: today },
        },
      }),
      this.prisma.timeOff.count({
        where: {
          startDate: { gt: today, lte: in30 },
        },
      }),
      this.prisma.timeOff.findMany({
        where: {
          type: 'VACATION',
          startDate: { lte: yearEnd },
          endDate: { gte: yearStart },
        },
        select: { startDate: true, endDate: true },
      }),
      this.prisma.timeOff.findMany({
        where: {
          type: 'SICK_LEAVE',
          startDate: { lte: yearEnd },
          endDate: { gte: yearStart },
        },
        select: { startDate: true, endDate: true },
      }),
    ]);

    const vacationDaysThisYear = vacRows.reduce(
      (acc, r) => acc + this.workingDaysInYear(r.startDate, r.endDate, year),
      0,
    );
    const sickDaysThisYear = sickRows.reduce(
      (acc, r) => acc + this.workingDaysInYear(r.startDate, r.endDate, year),
      0,
    );

    return {
      year,
      outToday,
      upcomingIn30Days: upcoming,
      vacationDaysThisYear,
      sickDaysThisYear,
    };
  }

  // ─── Calendar (wall-chart source) ──────────────────────────────────────

  async calendar(year: number, month: number, search: string | undefined) {
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));

    const employees = await this.prisma.employee.findMany({
      where: {
        ...(search
          ? {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        positions: true,
      },
    });

    const rows = await this.prisma.timeOff.findMany({
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
      select: {
        id: true,
        employeeId: true,
        type: true,
        startDate: true,
        endDate: true,
        note: true,
      },
    });

    return {
      year,
      month,
      daysInMonth: monthEnd.getUTCDate(),
      employees,
      records: rows.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        type: r.type,
        // Clip visible range to the current month so the frontend can
        // draw the intersecting segment without extra arithmetic.
        startDate: (r.startDate < monthStart ? monthStart : r.startDate)
          .toISOString()
          .slice(0, 10),
        endDate: (r.endDate > monthEnd ? monthEnd : r.endDate)
          .toISOString()
          .slice(0, 10),
        continuesLeft: r.startDate < monthStart,
        continuesRight: r.endDate > monthEnd,
        note: r.note,
      })),
    };
  }

  // ─── Balances (annual) ─────────────────────────────────────────────────

  async balances(year: number) {
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const today = this.toUtcDate(new Date());

    const employees = await this.prisma.employee.findMany({
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        positions: true,
      },
    });

    const rows = await this.prisma.timeOff.findMany({
      where: {
        OR: [
          {
            startDate: { lte: yearEnd },
            endDate: { gte: yearStart },
          },
          { startDate: { gte: today } },
        ],
      },
      select: {
        employeeId: true,
        type: true,
        startDate: true,
        endDate: true,
      },
      orderBy: [{ startDate: 'asc' }],
    });

    return {
      year,
      allowances: {
        vacation: VACATION_ALLOWANCE,
        sickLeave: SICK_LEAVE_ALLOWANCE,
      },
      employees: employees.map((e) => {
        const empRows = rows.filter((r) => r.employeeId === e.id);
        const vacUsed = empRows
          .filter((r) => r.type === 'VACATION')
          .reduce(
            (acc, r) => acc + this.workingDaysInYear(r.startDate, r.endDate, year),
            0,
          );
        const sickUsed = empRows
          .filter((r) => r.type === 'SICK_LEAVE')
          .reduce(
            (acc, r) => acc + this.workingDaysInYear(r.startDate, r.endDate, year),
            0,
          );
        const unpaid = empRows
          .filter((r) => r.type === 'UNPAID_LEAVE')
          .reduce(
            (acc, r) => acc + this.workingDaysInYear(r.startDate, r.endDate, year),
            0,
          );
        const upcoming = empRows.find((r) => r.startDate > today);
        return {
          employee: {
            id: e.id,
            firstName: e.firstName,
            lastName: e.lastName,
            status: e.status,
            positions: e.positions,
          },
          vacationUsed: vacUsed,
          vacationRemaining: Math.max(0, VACATION_ALLOWANCE - vacUsed),
          sickUsed,
          sickRemaining: Math.max(0, SICK_LEAVE_ALLOWANCE - sickUsed),
          unpaidDays: unpaid,
          nextAbsence: upcoming
            ? {
                type: upcoming.type,
                startDate: upcoming.startDate.toISOString().slice(0, 10),
                endDate: upcoming.endDate.toISOString().slice(0, 10),
              }
            : null,
        };
      }),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private include(): Prisma.TimeOffInclude {
    return {
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          status: true,
          positions: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    };
  }

  private buildOrderBy(
    sortBy: TimeOffSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.TimeOffOrderByWithRelationInput[] {
    switch (sortBy) {
      case TimeOffSortBy.endDate:
        return [{ endDate: dir }, { startDate: dir }];
      case TimeOffSortBy.type:
        return [{ type: dir }, { startDate: 'desc' }];
      case TimeOffSortBy.workingDays:
        return [{ workingDays: dir }];
      case TimeOffSortBy.createdAt:
        return [{ createdAt: dir }];
      case TimeOffSortBy.updatedAt:
        return [{ updatedAt: dir }];
      case TimeOffSortBy.startDate:
      default:
        return [{ startDate: dir }, { endDate: dir }];
    }
  }

  /**
   * Parse a YYYY-MM-DD string into a midnight-UTC Date. Prevents the
   * timezone-shift bug where a naive `new Date('2026-01-01')` in a
   * non-UTC environment could land on 2025-12-31.
   */
  private parseDay(iso: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) throw new BadRequestException(`Invalid date: ${iso}`);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  private toUtcDate(d: Date): Date {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }

  private assertRangeValid(start: Date, end: Date): void {
    if (end.getTime() < start.getTime()) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
  }

  private async assertEmployeeExists(employeeId: string): Promise<void> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!emp) throw new BadRequestException('Employee not found');
  }

  private async assertNoOverlap(
    employeeId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<void> {
    const overlap = await this.prisma.timeOff.findFirst({
      where: {
        employeeId,
        startDate: { lte: end },
        endDate: { gte: start },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true, startDate: true, endDate: true },
    });
    if (overlap) {
      throw new ConflictException(
        'This employee already has time off overlapping the requested range',
      );
    }
  }

  private async assertWithinAllowance(
    employeeId: string,
    type: TimeOffType,
    start: Date,
    end: Date,
    excludeId?: string,
    policy?: Awaited<ReturnType<TimeOffService['getPolicy']>>,
  ): Promise<void> {
    const live = policy ?? (await this.getPolicy());
    const allowance =
      type === 'VACATION'
        ? live.vacationAllowance
        : type === 'SICK_LEAVE'
          ? live.sickAllowance
          : null;
    if (!allowance) return; // UNPAID_LEAVE — no cap.

    const years = new Set<number>();
    for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
      years.add(y);
    }

    for (const year of years) {
      const requestedDays = this.workingDaysInYear(
        start,
        end,
        year,
        live.workingWeekdays,
      );
      if (requestedDays === 0) continue;

      const existing = await this.prisma.timeOff.findMany({
        where: {
          employeeId,
          type,
          startDate: { lte: new Date(Date.UTC(year, 11, 31)) },
          endDate: { gte: new Date(Date.UTC(year, 0, 1)) },
          ...(excludeId ? { NOT: { id: excludeId } } : {}),
        },
        select: { startDate: true, endDate: true },
      });
      const used = existing.reduce(
        (acc, r) =>
          acc + this.workingDaysInYear(r.startDate, r.endDate, year, live.workingWeekdays),
        0,
      );
      const total = used + requestedDays;
      if (total > allowance) {
        const label = type === 'VACATION' ? 'Vacation' : 'Sick Leave';
        if (live.allowNegativeBalance) {
          // Policy permits a negative balance — don't throw. The UI
          // can still render a warning based on the result.
          return;
        }
        throw new ConflictException(
          `${label} allowance for ${year} would exceed the annual limit ` +
            `(${allowance} working days). Already used: ${used}, ` +
            `requested: ${requestedDays}.`,
        );
      }
    }
  }

  /** Count working-weekday days between start and end inclusive. */
  private workingDaysBetween(
    start: Date,
    end: Date,
    workingWeekdays: Set<number> = new Set([1, 2, 3, 4, 5]),
  ): number {
    let count = 0;
    const cur = new Date(start);
    while (cur.getTime() <= end.getTime()) {
      if (workingWeekdays.has(cur.getUTCDay())) count++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return count;
  }

  /**
   * Working days between start..end that fall inside the given calendar
   * year. Used for allowance accounting on year-crossing ranges.
   */
  private workingDaysInYear(
    start: Date,
    end: Date,
    year: number,
    workingWeekdays?: Set<number>,
  ): number {
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const from = start < yearStart ? yearStart : start;
    const to = end > yearEnd ? yearEnd : end;
    if (to < from) return 0;
    return this.workingDaysBetween(from, to, workingWeekdays);
  }

  private mapWriteError(e: unknown): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2003') {
        return new BadRequestException('Related record not found');
      }
    }
    return e as Error;
  }
}

// Re-export for consumers.
export type TimeOffRecord = TimeOff;
