import { describe, it, expect } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';

import { AuthUser, scopePolicy } from './auth-user';

const userWith = (...keys: string[]): AuthUser => ({
  id: 'u1',
  permissions: new Set(keys),
});

describe('scopePolicy — contractor scope semantics', () => {
  it('visibleTypes is client-only when no contractor scope is granted', () => {
    expect(scopePolicy.visibleTypes(userWith())).toEqual(['client']);
    expect(scopePolicy.visibleTypes(userWith('counterparties:view'))).toEqual([
      'client',
    ]);
  });

  it('visibleTypes widens to both when contractor_scope:view is granted', () => {
    expect(
      scopePolicy.visibleTypes(userWith('contractor_scope:view')),
    ).toEqual(['client', 'contractor']);
  });

  it('visibleTypes widens to both when only contractor_scope:manage is granted', () => {
    expect(
      scopePolicy.visibleTypes(userWith('contractor_scope:manage')),
    ).toEqual(['client', 'contractor']);
  });

  it('assertCanReadType(client) never throws', () => {
    expect(() => scopePolicy.assertCanReadType(userWith(), 'client')).not.toThrow();
    expect(() =>
      scopePolicy.assertCanReadType(userWith('contractor_scope:view'), 'client'),
    ).not.toThrow();
  });

  it('assertCanReadType(contractor) throws 403 without contractor_scope:view or :manage', () => {
    expect(() => scopePolicy.assertCanReadType(userWith(), 'contractor')).toThrow(
      ForbiddenException,
    );
  });

  it('assertCanReadType(contractor) passes with contractor_scope:view', () => {
    expect(() =>
      scopePolicy.assertCanReadType(
        userWith('contractor_scope:view'),
        'contractor',
      ),
    ).not.toThrow();
  });

  it('assertCanReadType(contractor) passes with contractor_scope:manage even without :view', () => {
    expect(() =>
      scopePolicy.assertCanReadType(
        userWith('contractor_scope:manage'),
        'contractor',
      ),
    ).not.toThrow();
  });

  it('assertCanManageType(contractor) requires contractor_scope:manage', () => {
    expect(() =>
      scopePolicy.assertCanManageType(userWith(), 'contractor'),
    ).toThrow(ForbiddenException);
    expect(() =>
      scopePolicy.assertCanManageType(
        userWith('contractor_scope:view'),
        'contractor',
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      scopePolicy.assertCanManageType(
        userWith('contractor_scope:manage'),
        'contractor',
      ),
    ).not.toThrow();
  });

  it('assertCanManageType(client) never throws', () => {
    expect(() =>
      scopePolicy.assertCanManageType(userWith(), 'client'),
    ).not.toThrow();
  });
});
