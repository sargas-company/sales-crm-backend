import { describe, it, expect } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { HardDeleteAccountDto } from './update-account.dto';
import { HardDeleteProfileDto } from './list-profiles.dto';

/**
 * Regression tests for the hard-delete bodies: previously `confirmation`
 * and `mfa` were untyped on the DTO so the global ValidationPipe
 * (`whitelist` + `forbidNonWhitelisted`) stripped `mfa` and refused the
 * payload, which made hard delete unusable. Both fields must now be
 * declared and both branches of the `MfaStepUpDto` (`passkey` and
 * `totp`) must survive validation.
 */
describe('Credentials hard-delete DTOs', () => {
  it('HardDeleteAccountDto accepts { confirmation, mfa.totp }', async () => {
    const dto = plainToInstance(
      HardDeleteAccountDto,
      {
        confirmation: 'MyService',
        mfa: { method: 'totp', code: '123456' },
      },
      { enableImplicitConversion: true },
    );
    const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errs).toEqual([]);
    expect(dto.confirmation).toBe('MyService');
    expect(dto.mfa.method).toBe('totp');
  });

  it('HardDeleteProfileDto accepts { confirmation, mfa.passkey }', async () => {
    const dto = plainToInstance(
      HardDeleteProfileDto,
      {
        confirmation: 'My Profile',
        mfa: { method: 'passkey', assertion: { id: 'abc' } },
      },
      { enableImplicitConversion: true },
    );
    const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errs).toEqual([]);
    expect(dto.mfa.method).toBe('passkey');
  });

  it('HardDeleteAccountDto rejects an unknown mfa.method', async () => {
    const dto = plainToInstance(HardDeleteAccountDto, {
      confirmation: 'x',
      mfa: { method: 'sms', code: '000000' },
    });
    const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('HardDeleteAccountDto rejects a missing confirmation', async () => {
    const dto = plainToInstance(HardDeleteAccountDto, {
      mfa: { method: 'totp', code: '123456' },
    });
    const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errs.some((e) => e.property === 'confirmation')).toBe(true);
  });
});
