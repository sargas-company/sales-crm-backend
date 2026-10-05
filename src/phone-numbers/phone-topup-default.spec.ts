import { describe, it, expect, jest } from '@jest/globals';

import { PhoneMaintenanceService } from './phone-maintenance.service';
import { SK } from '../settings/settings-registry';

function makeSvc(settingValue?: number) {
  const settingsStub = {
    getNumberForKey: jest.fn(async (_key: string, fallback: number) =>
      settingValue ?? fallback,
    ),
  };
  const svc = new PhoneMaintenanceService(
    {} as never,
    {} as never,
    settingsStub as unknown as never,
  );
  return svc;
}

describe('PhoneMaintenanceService.getDefaultTopUpAmount', () => {
  it('returns the configured amount when set', async () => {
    expect(await makeSvc(25).getDefaultTopUpAmount()).toBe(25);
  });

  it('falls back to 10 when the setting is missing', async () => {
    expect(await makeSvc(undefined).getDefaultTopUpAmount()).toBe(10);
  });

  it('clamps negative or NaN values back to the fallback', async () => {
    expect(await makeSvc(-5).getDefaultTopUpAmount()).toBe(10);
    expect(await makeSvc(Number.NaN).getDefaultTopUpAmount()).toBe(10);
  });

  it('clamps very large values to the 1000 ceiling', async () => {
    expect(await makeSvc(100000).getDefaultTopUpAmount()).toBe(1000);
  });

  it('references the correct settings key', () => {
    expect(SK.PHONE_DEFAULTS_TOPUP_AMOUNT).toBe('phoneDefaults.topUpAmount');
  });
});
