/**
 * 18:00 reminder content + weekly digest colour parity.
 */
import { describe, expect, it } from '@jest/globals';

import { DiscordEmbedBuilderService } from './discord-embed-builder.service';

const svc = new DiscordEmbedBuilderService();

describe('DiscordEmbedBuilderService.reminderContent', () => {
  it('includes the CRM reports URL when provided', () => {
    const content = svc.reminderContent(
      '123456789012345678',
      'https://admin.example/projects/reports',
    );
    expect(content).toContain('<@&123456789012345678>');
    expect(content).toContain('https://admin.example/projects/reports');
  });
  it('omits the URL cleanly when not provided', () => {
    const content = svc.reminderContent('123456789012345678', '');
    expect(content).toBe('<@&123456789012345678>, please file the daily reports.');
  });
  it('omits the mention prefix when managerRoleId is null', () => {
    const content = svc.reminderContent(null, 'https://admin.example/x');
    expect(content).toBe('please file the daily reports. https://admin.example/x');
  });
});

describe('DiscordEmbedBuilderService.weeklyDigestEmbeds — threshold + 0-hour parity', () => {
  const COLOR_GREEN = 5763719;
  const COLOR_RED = 15548997;

  it('0 hours → red', () => {
    const [e] = svc.weeklyDigestEmbeds([{ projectName: 'Zero', hours: 0 }]);
    expect(e.color).toBe(COLOR_RED);
    expect(e.description).toBe('0.00 hours');
  });
  it('exactly 34 hours → red (strict > threshold matches legacy Laravel)', () => {
    const [e] = svc.weeklyDigestEmbeds([
      { projectName: 'Edge', hours: 34 },
    ]);
    expect(e.color).toBe(COLOR_RED);
  });
  it('34.01 hours → green', () => {
    const [e] = svc.weeklyDigestEmbeds([
      { projectName: 'Over', hours: 34.01 },
    ]);
    expect(e.color).toBe(COLOR_GREEN);
  });
});
