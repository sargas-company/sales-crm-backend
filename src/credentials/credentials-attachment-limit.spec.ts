import { describe, it, expect, jest } from '@jest/globals';

import { CredentialsAttachmentService } from './credentials-attachment.service';
import { SK } from '../settings/settings-registry';

/** The attachment limit must honor Settings while never exceeding the
 *  absolute safety ceiling and never dropping below 1 MB. */

function makeSvc(settingMb: number) {
  const settingsStub = {
    getNumberForKey: jest.fn(async (_key: string, fallback: number) => settingMb ?? fallback),
  };
  const svc = new CredentialsAttachmentService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    settingsStub as unknown as never,
  );
  return svc;
}

describe('CredentialsAttachmentService.getMaxAttachmentBytes', () => {
  it('reads the setting and converts MB to bytes', async () => {
    const svc = makeSvc(8);
    expect(await svc.getMaxAttachmentBytes()).toBe(8 * 1024 * 1024);
  });

  it('clamps settings above the absolute 50 MB ceiling', async () => {
    const svc = makeSvc(500);
    expect(await svc.getMaxAttachmentBytes()).toBe(50 * 1024 * 1024);
  });

  it('clamps non-positive settings up to 1 MB', async () => {
    for (const mb of [0, -5, 0.3]) {
      const svc = makeSvc(mb);
      expect(await svc.getMaxAttachmentBytes()).toBe(1 * 1024 * 1024);
    }
  });

  it('references the correct settings key', () => {
    expect(SK.CREDENTIALS_MAX_ATTACHMENT_MB).toBe(
      'credentials.maxAttachmentMegabytes',
    );
  });
});
