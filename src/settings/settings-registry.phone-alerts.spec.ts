/**
 * Phone-alerts registry regression — obsolete keys are gone.
 *
 * `phoneAlerts.webhookUrl` and `phoneAlerts.mention` were retired
 * when phone-maintenance delivery moved to the active DiscordProfile
 * + bot (`opsChannelId` + `managerRoleId`). Nothing reads them any
 * more; the catalogue must not expose them either, otherwise the
 * Settings UI would show dead fields.
 */
import { describe, expect, it } from '@jest/globals';

import { SETTINGS_REGISTRY } from './settings-registry';

const OBSOLETE_KEYS = ['phoneAlerts.webhookUrl', 'phoneAlerts.mention'];

describe('settings-registry — phone-alerts obsolete keys', () => {
  it('obsolete keys are NOT in the registry catalogue', () => {
    const leaked = OBSOLETE_KEYS.filter((k) =>
      Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, k),
    );
    expect(leaked).toEqual([]);
  });

  it('no registry entry still carries an obsolete key field', () => {
    const entryKeys = Object.values(SETTINGS_REGISTRY).map((e) => e.key);
    const leaked = OBSOLETE_KEYS.filter((k) =>
      (entryKeys as string[]).includes(k),
    );
    expect(leaked).toEqual([]);
  });
});
