import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const MONTH_NAMES_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function mondayOfWeekContaining(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

function labelWeek(start: Date, end: Date): string {
  const s = start.getUTCDate();
  const e = end.getUTCDate();
  const sm = MONTH_NAMES_SHORT[start.getUTCMonth()];
  const em = MONTH_NAMES_SHORT[end.getUTCMonth()];
  if (sm === em) return `${s}–${e} ${sm}`;
  return `${s} ${sm} – ${e} ${em}`;
}

async function generateYear(year: number) {
  const anchor = mondayOfWeekContaining(new Date(Date.UTC(year, 0, 1)));
  const pattern = [4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5];
  let weekCursor = anchor;

  for (let idx = 0; idx < 12; idx++) {
    const weeksInMonth = pattern[idx];
    const monthStart = weekCursor;
    const monthEnd = addDays(weekCursor, weeksInMonth * 7 - 1);
    const middleDay = addDays(monthStart, Math.floor((weeksInMonth * 7) / 2));
    const monthName = MONTH_NAMES[middleDay.getUTCMonth()];
    const label = `${monthName} ${year}`;

    const fm = await prisma.fiscalMonth.upsert({
      where: { year_sequenceInYear: { year, sequenceInYear: idx + 1 } },
      update: {
        startDate: monthStart,
        endDate: monthEnd,
        weeksCount: weeksInMonth,
        label,
      },
      create: {
        year,
        sequenceInYear: idx + 1,
        startDate: monthStart,
        endDate: monthEnd,
        weeksCount: weeksInMonth,
        label,
      },
    });

    for (let w = 0; w < weeksInMonth; w++) {
      const ws = addDays(weekCursor, w * 7);
      const we = addDays(ws, 6);
      await prisma.fiscalWeek.upsert({
        where: {
          fiscalMonthId_indexInMonth: {
            fiscalMonthId: fm.id,
            indexInMonth: w + 1,
          },
        },
        update: {
          startDate: ws,
          endDate: we,
          label: labelWeek(ws, we),
        },
        create: {
          fiscalMonthId: fm.id,
          indexInMonth: w + 1,
          startDate: ws,
          endDate: we,
          label: labelWeek(ws, we),
        },
      });
    }

    weekCursor = addDays(monthEnd, 1);
  }
}

async function main() {
  const years = [2025, 2026, 2027, 2028];
  for (const y of years) {
    console.log(`Generating fiscal calendar for ${y}...`);
    await generateYear(y);
  }
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
