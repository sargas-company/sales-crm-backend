import { describe, it, expect } from '@jest/globals';
import { evaluateScratchTarget } from './scratch-restore-guard';

describe('evaluateScratchTarget', () => {
  it('accepts localhost scratch targets with _restore_ marker', () => {
    const r = evaluateScratchTarget(
      'postgres://u:p@localhost:5433/ai_dashboard_restore_run1',
    );
    expect(r.ok).toBe(true);
    expect(r.database).toBe('ai_dashboard_restore_run1');
  });

  it('accepts localhost scratch targets with _scratch marker', () => {
    expect(
      evaluateScratchTarget('postgres://u:p@127.0.0.1:5433/some_scratch').ok,
    ).toBe(true);
  });

  it('refuses non-local host even with correct name', () => {
    const r = evaluateScratchTarget(
      'postgres://u:p@prod.example.com:5432/ai_dashboard_restore_run1',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not local');
  });

  it('refuses local host without scratch marker in db name', () => {
    const r = evaluateScratchTarget(
      'postgres://u:p@localhost:5433/ai_dashboard',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('_restore_');
  });

  it('refuses malformed URL', () => {
    expect(evaluateScratchTarget('not a url').ok).toBe(false);
  });
});
