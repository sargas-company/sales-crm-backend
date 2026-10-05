import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditResult,
  AuditSeverity,
  PayrollStatus,
  Prisma,
  RateType,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { safeDiff } from '../audit-event/audit-sanitizer';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import { CreatePayrollDto } from './dto/create-payroll.dto';
import {
  ListPayrollDto,
  PayrollSortBy,
  PayrollSortDirection,
} from './dto/list-payroll.dto';
import { UpdatePayrollDto } from './dto/update-payroll.dto';

const { Decimal } = Prisma;
type D = Prisma.Decimal;

// Formula constants (spec §1).
const TAX_FIXED = new Decimal('42.5'); // fixed contribution
const TAX_RATE = new Decimal('0.06'); // 5% + 1% flat
const PAYONEER_RATE = new Decimal('0.03');

@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Pull the live coefficients from Settings. The result is baked
   * into the entry when it is created / updated, so a Paid run keeps
   * the historical snapshot even after Settings changes.
   */
  private async currentCoefficients() {
    const [fixedTax, taxPercent, payoneerFeePercent] = await Promise.all([
      this.settings.getNumberForKey(SK.PAYROLL_FIXED_TAX, 42.5),
      this.settings.getNumberForKey(SK.PAYROLL_TAX_PERCENT, 6),
      this.settings.getNumberForKey(SK.PAYROLL_PAYONEER_FEE_PERCENT, 3),
    ]);
    return {
      fixedTax: new Decimal(fixedTax),
      taxRate: new Decimal(taxPercent).div(100),
      payoneerRate: new Decimal(payoneerFeePercent).div(100),
    };
  }

  /** Enforce the configured paid-run lock. When
   *  `PAYROLL_LOCK_PAID_RUNS=true` any mutation of a PAID row (other
   *  than `reopen`) is rejected with a 409 and an audit DENIED event.
   *  When the lock is off, we still log the mutation attempt so the
   *  trail is complete. */
  private async assertPaidMutable(
    entry: { id: string; employee: { firstName: string | null; lastName: string | null }; year: number; month: number },
    actorId: string,
    action: 'payroll.update' | 'payroll.delete' | 'payroll.markPaid',
  ) {
    const locked = await this.settings.getBooleanForKey(
      SK.PAYROLL_LOCK_PAID_RUNS,
      true,
    );
    if (!locked) return;
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action,
      targetType: 'PayrollEntry',
      targetId: entry.id,
      targetLabel: this.payrollLabel(entry, entry.employee),
      result: AuditResult.DENIED,
      severity: AuditSeverity.WARNING,
    });
    throw new ConflictException(
      'Paid payroll runs are locked. Reopen the entry first (requires salaries:reopen).',
    );
  }

  private payrollLabel(
    entry: { year: number; month: number },
    employee: { firstName: string | null; lastName: string | null },
  ) {
    const month = String(entry.month).padStart(2, '0');
    const name =
      `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim();
    return `${name} · ${entry.year}-${month}`;
  }

  // ─── CRUD ────────────────────────────────────────────────────────────

  async findAll(dto: ListPayrollDto) {
    const dir: Prisma.SortOrder =
      (dto.sortDirection as Prisma.SortOrder | undefined) ??
      PayrollSortDirection.desc;

    const where: Prisma.PayrollEntryWhereInput = {
      year: dto.year,
      month: dto.month,
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.search
        ? {
            employee: {
              OR: [
                { firstName: { contains: dto.search, mode: 'insensitive' } },
                { lastName: { contains: dto.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const orderBy = this.buildOrderBy(dto.sortBy, dir);
    const rows = await this.prisma.payrollEntry.findMany({
      where,
      orderBy,
      include: this.include(),
    });
    return { data: rows };
  }

  async findOne(id: string) {
    const row = await this.prisma.payrollEntry.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!row) throw new NotFoundException('Payroll entry not found');
    return row;
  }

  async summary(year: number, month: number) {
    const rows = await this.prisma.payrollEntry.findMany({
      where: { year, month },
      select: {
        baseSalary: true,
        tax: true,
        bonusAmount: true,
        totalAccrued: true,
        payoneerFee: true,
        companyCost: true,
        remainingToPay: true,
        status: true,
      },
    });
    const zero = new Decimal(0);
    let base = zero;
    let tax = zero;
    let bonuses = zero;
    let accrued = zero;
    let fee = zero;
    let cost = zero;
    let outstanding = zero;
    let draftCount = 0;
    let paidCount = 0;
    for (const r of rows) {
      base = base.plus(r.baseSalary);
      tax = tax.plus(r.tax);
      bonuses = bonuses.plus(r.bonusAmount);
      accrued = accrued.plus(r.totalAccrued);
      fee = fee.plus(r.payoneerFee);
      cost = cost.plus(r.companyCost);
      outstanding = outstanding.plus(r.remainingToPay);
      if (r.status === 'DRAFT') draftCount++;
      else paidCount++;
    }
    return {
      year,
      month,
      count: rows.length,
      draftCount,
      paidCount,
      baseSalaries: base.toFixed(2),
      taxes: tax.toFixed(2),
      bonuses: bonuses.toFixed(2),
      totalAccrued: accrued.toFixed(2),
      payoneerFees: fee.toFixed(2),
      companyCost: cost.toFixed(2),
      outstanding: outstanding.toFixed(2),
    };
  }

  async create(dto: CreatePayrollDto, actorId: string) {
    await this.assertEmployeeExists(dto.employeeId);
    if (dto.rateType === 'HOURLY' && (dto.hours == null || dto.hours < 0)) {
      throw new BadRequestException('hours is required for HOURLY entries');
    }

    const rate = new Decimal(dto.rate);
    const hours =
      dto.rateType === 'HOURLY' ? new Decimal(dto.hours ?? 0) : null;
    const bonusPercent = new Decimal(dto.bonusPercent ?? 0);
    const fixedBonus = new Decimal(dto.fixedBonus ?? 0);
    const advance = new Decimal(dto.advance ?? 0);

    const coeffs = await this.currentCoefficients();
    const numbers = this.computeAll(
      {
        rateType: dto.rateType,
        rate,
        hours,
        bonusPercent,
        fixedBonus,
        advance,
      },
      coeffs,
    );

    try {
      const created = await this.prisma.payrollEntry.create({
        data: {
          employeeId: dto.employeeId,
          year: dto.year,
          month: dto.month,
          rateType: dto.rateType,
          rate,
          hours,
          bonusPercent,
          fixedBonus,
          advance,
          note: dto.note,
          ...numbers,
        },
        include: this.include(),
      });
      await this.audit.recordSafe({
        actorUserId: actorId,
        domain: 'FINANCE',
        action: 'payroll.create',
        targetType: 'PayrollEntry',
        targetId: created.id,
        targetLabel: this.payrollLabel(created, created.employee),
        result: AuditResult.SUCCESS,
        metadata: {
          employeeId: dto.employeeId,
          rateType: created.rateType,
          totalAccrued: created.totalAccrued?.toString() ?? null,
        },
      });
      return created;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'A payroll entry already exists for this employee and month',
        );
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdatePayrollDto, actorId: string) {
    const existing = await this.prisma.payrollEntry.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!existing) throw new NotFoundException('Payroll entry not found');
    if (existing.status === 'PAID') {
      await this.assertPaidMutable(existing, actorId, 'payroll.update');
    }

    const rateType = (dto.rateType ?? existing.rateType) as RateType;
    const rate = new Decimal(dto.rate ?? existing.rate);
    const hours =
      rateType === 'HOURLY'
        ? new Decimal(dto.hours ?? existing.hours ?? 0)
        : null;
    const bonusPercent = new Decimal(dto.bonusPercent ?? existing.bonusPercent);
    const fixedBonus = new Decimal(dto.fixedBonus ?? existing.fixedBonus);
    const advance = new Decimal(dto.advance ?? existing.advance);

    const coeffs = await this.currentCoefficients();
    const numbers = this.computeAll(
      {
        rateType,
        rate,
        hours,
        bonusPercent,
        fixedBonus,
        advance,
      },
      coeffs,
    );

    const updated = await this.prisma.payrollEntry.update({
      where: { id },
      data: {
        rateType,
        rate,
        hours,
        bonusPercent,
        fixedBonus,
        advance,
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...numbers,
      },
      include: this.include(),
    });
    const changes = safeDiff(
      {
        rate: existing.rate.toString(),
        hours: existing.hours?.toString() ?? null,
        bonusPercent: existing.bonusPercent.toString(),
        fixedBonus: existing.fixedBonus.toString(),
        advance: existing.advance.toString(),
        totalAccrued: existing.totalAccrued.toString(),
      },
      {
        rate: updated.rate.toString(),
        hours: updated.hours?.toString() ?? null,
        bonusPercent: updated.bonusPercent.toString(),
        fixedBonus: updated.fixedBonus.toString(),
        advance: updated.advance.toString(),
        totalAccrued: updated.totalAccrued.toString(),
      },
    );
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action: 'payroll.update',
      targetType: 'PayrollEntry',
      targetId: id,
      targetLabel: this.payrollLabel(updated, updated.employee),
      result: AuditResult.SUCCESS,
      changes: changes ?? null,
    });
    return updated;
  }

  async remove(id: string, actorId: string) {
    const existing = await this.prisma.payrollEntry.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!existing) throw new NotFoundException('Payroll entry not found');
    if (existing.status === 'PAID') {
      await this.assertPaidMutable(existing, actorId, 'payroll.delete');
    }
    await this.prisma.payrollEntry.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action: 'payroll.delete',
      targetType: 'PayrollEntry',
      targetId: id,
      targetLabel: this.payrollLabel(existing, existing.employee),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }

  async markPaid(id: string, actorId: string) {
    const existing = await this.prisma.payrollEntry.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!existing) throw new NotFoundException('Payroll entry not found');
    if (existing.status === 'PAID') {
      // Idempotent re-mark attempt — treated as a mutation of a PAID
      // row so the lock + audit path applies.
      await this.assertPaidMutable(existing, actorId, 'payroll.markPaid');
      return existing;
    }
    const updated = await this.prisma.payrollEntry.update({
      where: { id },
      data: { status: PayrollStatus.PAID, paidAt: new Date() },
      include: this.include(),
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action: 'payroll.markPaid',
      targetType: 'PayrollEntry',
      targetId: id,
      targetLabel: this.payrollLabel(updated, updated.employee),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
      changes: {
        status: { before: existing.status, after: updated.status },
      },
    });
    return updated;
  }

  async reopen(id: string, actorId: string) {
    const existing = await this.prisma.payrollEntry.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!existing) throw new NotFoundException('Payroll entry not found');
    if (existing.status === 'DRAFT') return existing;
    const reopenAllowed = await this.settings.getBooleanForKey(
      SK.PAYROLL_ALLOW_OWNER_REOPEN,
      true,
    );
    if (!reopenAllowed) {
      await this.audit.recordSafe({
        actorUserId: actorId,
        domain: 'FINANCE',
        action: 'payroll.reopen',
        targetType: 'PayrollEntry',
        targetId: id,
        targetLabel: this.payrollLabel(existing, existing.employee),
        result: AuditResult.DENIED,
        severity: AuditSeverity.WARNING,
      });
      throw new ConflictException(
        'Reopen is disabled by payroll.allowOwnerReopen setting.',
      );
    }
    const updated = await this.prisma.payrollEntry.update({
      where: { id },
      data: { status: PayrollStatus.DRAFT, paidAt: null },
      include: this.include(),
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action: 'payroll.reopen',
      targetType: 'PayrollEntry',
      targetId: id,
      targetLabel: this.payrollLabel(updated, updated.employee),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
      changes: {
        status: { before: existing.status, after: updated.status },
      },
    });
    return updated;
  }

  // ─── Analytics helpers ────────────────────────────────────────────────

  async monthlySeries(fromYear: number, fromMonth: number, months: number) {
    const monthKey = (y: number, m: number) => y * 100 + m;
    const buckets: { year: number; month: number; key: number }[] = [];
    let y = fromYear;
    let m = fromMonth;
    for (let i = 0; i < months; i++) {
      buckets.push({ year: y, month: m, key: monthKey(y, m) });
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    const fromKey = buckets[0].key;
    const toKey = buckets[buckets.length - 1].key;

    const rows = await this.prisma.payrollEntry.findMany({
      where: {
        OR: buckets.map((b) => ({ year: b.year, month: b.month })),
      },
      select: {
        year: true,
        month: true,
        baseSalary: true,
        tax: true,
        bonusAmount: true,
        totalAccrued: true,
        payoneerFee: true,
        companyCost: true,
      },
    });

    const zero = new Decimal(0);
    const map = new Map<
      number,
      { base: D; tax: D; bonus: D; accrued: D; fee: D; cost: D }
    >();
    for (const b of buckets) {
      map.set(b.key, {
        base: zero,
        tax: zero,
        bonus: zero,
        accrued: zero,
        fee: zero,
        cost: zero,
      });
    }
    for (const r of rows) {
      const key = monthKey(r.year, r.month);
      if (key < fromKey || key > toKey) continue;
      const s = map.get(key)!;
      s.base = s.base.plus(r.baseSalary);
      s.tax = s.tax.plus(r.tax);
      s.bonus = s.bonus.plus(r.bonusAmount);
      s.accrued = s.accrued.plus(r.totalAccrued);
      s.fee = s.fee.plus(r.payoneerFee);
      s.cost = s.cost.plus(r.companyCost);
    }
    return buckets.map((b) => {
      const s = map.get(b.key)!;
      return {
        year: b.year,
        month: b.month,
        baseSalaries: s.base.toFixed(2),
        taxes: s.tax.toFixed(2),
        bonuses: s.bonus.toFixed(2),
        totalAccrued: s.accrued.toFixed(2),
        payoneerFees: s.fee.toFixed(2),
        companyCost: s.cost.toFixed(2),
      };
    });
  }

  async employeeBreakdown(year: number, month: number) {
    const rows = await this.prisma.payrollEntry.findMany({
      where: { year, month },
      include: this.include(),
      orderBy: { companyCost: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      employee: r.employee,
      rateType: r.rateType,
      baseSalary: r.baseSalary.toFixed(2),
      totalAccrued: r.totalAccrued.toFixed(2),
      companyCost: r.companyCost.toFixed(2),
      status: r.status,
    }));
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private computeAll(
    input: {
      rateType: RateType;
      rate: D;
      hours: D | null;
      bonusPercent: D;
      fixedBonus: D;
      advance: D;
    },
    coeffs: { fixedTax: D; taxRate: D; payoneerRate: D } = {
      fixedTax: TAX_FIXED,
      taxRate: TAX_RATE,
      payoneerRate: PAYONEER_RATE,
    },
  ) {
    const baseSalary = this.round2(
      input.rateType === 'HOURLY'
        ? input.rate.times(input.hours ?? new Decimal(0))
        : input.rate,
    );
    const tax = this.round2(
      coeffs.fixedTax.plus(baseSalary.times(coeffs.taxRate)),
    );
    const salaryWithTax = this.round2(baseSalary.plus(tax));
    const bonusAmount = this.round2(
      salaryWithTax.times(input.bonusPercent).div(100).plus(input.fixedBonus),
    );
    const totalAccrued = this.round2(salaryWithTax.plus(bonusAmount));
    const remainingRaw = totalAccrued.minus(input.advance);
    const remainingToPay = this.round2(
      remainingRaw.isNegative() ? new Decimal(0) : remainingRaw,
    );
    const payoneerFee = this.round2(totalAccrued.times(coeffs.payoneerRate));
    const companyCost = this.round2(totalAccrued.plus(payoneerFee));
    return {
      baseSalary,
      tax,
      salaryWithTax,
      bonusAmount,
      totalAccrued,
      remainingToPay,
      payoneerFee,
      companyCost,
    };
  }

  private round2(d: D): D {
    return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  private include(): Prisma.PayrollEntryInclude {
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
    };
  }

  private buildOrderBy(
    sortBy: PayrollSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.PayrollEntryOrderByWithRelationInput[] {
    switch (sortBy) {
      case PayrollSortBy.baseSalary:
        return [{ baseSalary: dir }];
      case PayrollSortBy.totalAccrued:
        return [{ totalAccrued: dir }];
      case PayrollSortBy.companyCost:
        return [{ companyCost: dir }];
      case PayrollSortBy.remainingToPay:
        return [{ remainingToPay: dir }];
      case PayrollSortBy.bonusAmount:
        return [{ bonusAmount: dir }];
      case PayrollSortBy.payoneerFee:
        return [{ payoneerFee: dir }];
      case PayrollSortBy.status:
        return [{ status: dir }, { createdAt: 'desc' }];
      case PayrollSortBy.createdAt:
        return [{ createdAt: dir }];
      case PayrollSortBy.employee:
      default:
        return [{ employee: { firstName: dir } }, { employee: { lastName: dir } }];
    }
  }

  private async assertEmployeeExists(employeeId: string): Promise<void> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!emp) throw new BadRequestException('Employee not found');
  }
}
