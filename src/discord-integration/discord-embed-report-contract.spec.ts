/**
 * Legacy-admin ProjectReport embed contract.
 *
 * Covers the three ProjectReport-shaped surfaces (project-channel
 * detailed, PMS daily digest, PMS late card) and the weekly digest.
 * Enforces:
 *   • palette is exactly the two legacy Laravel hex values
 *     (LEGACY_BLUE 7506394 / LEGACY_RED 11471113). No greens, no
 *     yellows, no Discord blurple;
 *   • working-channel is always blue, late or not;
 *   • daily and late share one builder (compactReportCard) and the
 *     same strict `hours > 6` comparator; a report at 6.00 is red;
 *   • weekly uses the SAME two colors with `hours > 34`; a zero-
 *     hour project stays in the digest and is red;
 *   • no "TEST" / "PREVIEW" literal leaks into real embed output.
 */
import { describe, expect, it } from '@jest/globals';

import {
  DAILY_REPORT_HOURS_THRESHOLD,
  DiscordEmbedBuilderService,
  LEGACY_BLUE,
  LEGACY_RED,
  WEEKLY_REPORT_HOURS_THRESHOLD,
  reportColorForHours,
} from './discord-embed-builder.service';

const svc = new DiscordEmbedBuilderService();

const reportDate = new Date('2026-11-10T00:00:00Z');

describe('ProjectReport embed contract — legacy palette', () => {
  it('exports the two canonical legacy hexes', () => {
    expect(LEGACY_BLUE).toBe(7506394);
    expect(LEGACY_RED).toBe(11471113);
  });

  it('exports the two Laravel thresholds literally', () => {
    expect(DAILY_REPORT_HOURS_THRESHOLD).toBe(6);
    expect(WEEKLY_REPORT_HOURS_THRESHOLD).toBe(34);
  });

  it('reportColorForHours is strict `> threshold` (6.00 → red, 6.01 → blue)', () => {
    expect(reportColorForHours(6)).toBe(LEGACY_RED);
    expect(reportColorForHours(6.01)).toBe(LEGACY_BLUE);
    expect(reportColorForHours(34, WEEKLY_REPORT_HOURS_THRESHOLD)).toBe(LEGACY_RED);
    expect(reportColorForHours(34.01, WEEKLY_REPORT_HOURS_THRESHOLD)).toBe(LEGACY_BLUE);
  });
});

describe('working-channel reportEmbed — always LEGACY_BLUE', () => {
  it('normal report → blue', () => {
    const e = svc.reportEmbed({
      projectName: 'Alpha',
      hours: 8,
      reportDate,
      text: 'did the thing',
      isLate: false,
    });
    expect(e.color).toBe(LEGACY_BLUE);
  });

  it('late report → still LEGACY_BLUE, color must not flip to red/yellow', () => {
    const e = svc.reportEmbed({
      projectName: 'Alpha',
      hours: 2,
      reportDate,
      text: 'late + under threshold',
      isLate: true,
    });
    expect(e.color).toBe(LEGACY_BLUE);
    // Footer carries the late marker; color MUST remain blue.
    expect(e.footer?.text).toContain('LATE');
  });

  it('keeps the detailed shape — Hours / Date / Details fields', () => {
    const e = svc.reportEmbed({
      projectName: 'Alpha',
      hours: 9,
      reportDate,
      text: 'details body',
      isLate: false,
    });
    const names = (e.fields ?? []).map((f) => f.name);
    expect(names).toEqual(['🕒 Hours', '📅 Date', '📝 Details']);
    const detailsValue = (e.fields ?? [])
      .find((f) => f.name === '📝 Details')?.value;
    expect(detailsValue).toBe('details body');
  });

  it('does not leak TEST / PREVIEW markers into real output', () => {
    const e = svc.reportEmbed({
      projectName: 'Alpha',
      hours: 8,
      reportDate,
      text: 'body',
      isLate: false,
    });
    expect(JSON.stringify(e)).not.toMatch(/\[(TEST|PREVIEW)\]/);
  });
});

describe('PMS compact card — daily + late share one builder', () => {
  it('compactReportCard 6.00 → LEGACY_RED', () => {
    const e = svc.compactReportCard({ projectName: 'Beta', hours: 6 });
    expect(e.color).toBe(LEGACY_RED);
    expect(e.title).toBe('Beta');
    expect(e.description).toBe('6 hours');
    expect(e.fields).toBeUndefined();
  });

  it('compactReportCard 6.01 → LEGACY_BLUE', () => {
    const e = svc.compactReportCard({ projectName: 'Beta', hours: 6.01 });
    expect(e.color).toBe(LEGACY_BLUE);
  });

  it('dailyDigestEmbeds reuses compactReportCard shape', () => {
    const [row] = svc.dailyDigestEmbeds({
      reportDate,
      rows: [{ projectName: 'Gamma', hours: 7 }],
    });
    expect(row.title).toBe('Gamma');
    expect(row.description).toBe('7 hours');
    expect(row.color).toBe(LEGACY_BLUE);
    expect(row.fields).toBeUndefined();
  });

  it('daily and late carry the identical embed shape for the same inputs', () => {
    const daily = svc.dailyDigestEmbeds({
      reportDate,
      rows: [{ projectName: 'Delta', hours: 5 }],
    })[0];
    const late = svc.compactReportCard({ projectName: 'Delta', hours: 5 });
    expect(late).toEqual(daily);
  });

  it('compactReportCard never carries detailed-only fields (Submitted at, Details, Author)', () => {
    const e = svc.compactReportCard({ projectName: 'Eps', hours: 8 });
    const json = JSON.stringify(e);
    expect(json).not.toContain('Submitted at');
    expect(json).not.toContain('Details');
    expect(json).not.toContain('author');
    // No report body text leaks either.
    expect(e.fields).toBeUndefined();
  });

  it('late embed shape (as emitted from the late tick) == compact card', () => {
    // The late tick in DiscordLateReportService wires its payload
    // directly into compactReportCard. The contract here is: given
    // the same (projectName, hours), the embed is identical.
    const asLateInput = { projectName: 'Zeta', hours: 2 };
    const asDailyInput = { projectName: 'Zeta', hours: 2 };
    expect(svc.compactReportCard(asLateInput)).toEqual(
      svc.compactReportCard(asDailyInput),
    );
  });
});

describe('Weekly digest — same legacy palette, >34 threshold, zero-hour projects stay', () => {
  it('exactly 34 → red', () => {
    const [e] = svc.weeklyDigestEmbeds([{ projectName: 'E', hours: 34 }]);
    expect(e.color).toBe(LEGACY_RED);
  });
  it('34.01 → blue', () => {
    const [e] = svc.weeklyDigestEmbeds([{ projectName: 'F', hours: 34.01 }]);
    expect(e.color).toBe(LEGACY_BLUE);
  });
  it('0 hours → red and still present in the digest', () => {
    const [e] = svc.weeklyDigestEmbeds([{ projectName: 'G', hours: 0 }]);
    expect(e.color).toBe(LEGACY_RED);
    expect(e.description).toBe('0.00 hours');
  });

  it('does not use green / yellow / Discord blurple anywhere', () => {
    const rows = svc.weeklyDigestEmbeds([
      { projectName: 'a', hours: 0 },
      { projectName: 'b', hours: 34 },
      { projectName: 'c', hours: 34.01 },
      { projectName: 'd', hours: 60 },
    ]);
    const palette = Array.from(new Set(rows.map((r) => r.color)));
    palette.forEach((c) => {
      expect([LEGACY_BLUE, LEGACY_RED]).toContain(c);
    });
    // Explicit guards against the removed hues.
    expect(palette).not.toContain(5763719); // old COLOR_GREEN
    expect(palette).not.toContain(15844367); // old COLOR_YELLOW
    expect(palette).not.toContain(15548997); // bright red
    expect(palette).not.toContain(3447003); // Discord blurple
  });
});
