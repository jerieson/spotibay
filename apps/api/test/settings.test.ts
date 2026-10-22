import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDefaults, type SettingKey } from '@spotibay/shared';
import {
  createSettingsService,
  SettingsValidationError,
  type SettingChange,
  type SettingsStore,
} from '../src/services/settings.js';

function fakeStore(initial: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>(Object.entries(initial));
  const upserts: Array<{ key: SettingKey; value: unknown; adminId: string | null }> = [];
  const store: SettingsStore = {
    loadAll: async () => new Map(rows),
    upsert: async (key, value, adminId) => {
      rows.set(key, value);
      upserts.push({ key, value, adminId });
    },
  };
  return { store, rows, upserts };
}

function counter() {
  let n = 0;
  return { bump: vi.fn(async () => ++n) };
}

describe('settings service', () => {
  let fake: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    fake = fakeStore();
  });

  it('throws if read before load', () => {
    const svc = createSettingsService(fake.store, counter());
    expect(() => svc.get('features.chat')).toThrow(/not loaded/);
  });

  it('fills missing keys from defaults', async () => {
    const svc = createSettingsService(fake.store, counter());
    await svc.load();
    expect(svc.all()).toEqual(settingsDefaults);
    expect(svc.get('limits.maxUsersPerRoom')).toBe(30);
  });

  it('prefers stored values over defaults', async () => {
    fake = fakeStore({ 'limits.maxUsersPerRoom': 5, 'features.chat': false });
    const svc = createSettingsService(fake.store, counter());
    await svc.load();
    expect(svc.get('limits.maxUsersPerRoom')).toBe(5);
    expect(svc.get('features.chat')).toBe(false);
  });

  it('falls back to the default when a stored value is invalid', async () => {
    fake = fakeStore({ 'limits.maxUsersPerRoom': 'lots', 'unknown.key': 1 });
    const svc = createSettingsService(fake.store, counter());
    await svc.load();
    expect(svc.get('limits.maxUsersPerRoom')).toBe(30);
    expect(svc.all()).not.toHaveProperty('unknown.key');
  });

  it('set validates, persists, updates the cache and bumps the version', async () => {
    const versions = counter();
    const svc = createSettingsService(fake.store, versions);
    await svc.load();
    const change = await svc.set('limits.maxQueueLength', 100, 'admin-1');
    expect(change).toMatchObject({ key: 'limits.maxQueueLength', value: 100, previous: 200, version: 1 });
    expect(svc.get('limits.maxQueueLength')).toBe(100);
    expect(svc.version).toBe(1);
    expect(fake.upserts).toEqual([{ key: 'limits.maxQueueLength', value: 100, adminId: 'admin-1' }]);
    await svc.set('limits.maxQueueLength', 150, null);
    expect(svc.version).toBe(2);
  });

  it('rejects invalid values without touching store, cache or version', async () => {
    const versions = counter();
    const svc = createSettingsService(fake.store, versions);
    await svc.load();
    await expect(svc.set('limits.maxQueueLength', -1, 'a')).rejects.toBeInstanceOf(SettingsValidationError);
    await expect(svc.set('queue.skipVoteThreshold', 1.5, 'a')).rejects.toBeInstanceOf(SettingsValidationError);
    await expect(svc.set('site.announcement', { text: 'hi', level: 'nope' }, 'a')).rejects.toThrow();
    expect(fake.upserts).toHaveLength(0);
    expect(versions.bump).not.toHaveBeenCalled();
    expect(svc.get('limits.maxQueueLength')).toBe(200);
  });

  it('rejects unknown keys', async () => {
    const svc = createSettingsService(fake.store, counter());
    await svc.load();
    await expect(svc.set('nope.nothing' as SettingKey, 1, 'a')).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
  });

  it('accepts a structured announcement and null', async () => {
    const svc = createSettingsService(fake.store, counter());
    await svc.load();
    await svc.set('site.announcement', { text: 'Maintenance at 9', level: 'warning' }, 'a');
    expect(svc.get('site.announcement')).toEqual({ text: 'Maintenance at 9', level: 'warning' });
    await svc.set('site.announcement', null, 'a');
    expect(svc.get('site.announcement')).toBeNull();
  });

  it('emits a change event and supports unsubscribe', async () => {
    const svc = createSettingsService(fake.store, counter());
    await svc.load();
    const seen: SettingChange[] = [];
    const off = svc.onChange((c) => seen.push(c));
    await svc.set('features.chat', false, 'a');
    off();
    await svc.set('features.chat', true, 'a');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ key: 'features.chat', value: false, previous: true });
  });

  it('does not emit or cache when persisting fails', async () => {
    const failing: SettingsStore = {
      loadAll: async () => new Map(),
      upsert: async () => {
        throw new Error('db down');
      },
    };
    const svc = createSettingsService(failing, counter());
    await svc.load();
    const listener = vi.fn();
    svc.onChange(listener);
    await expect(svc.set('features.chat', false, 'a')).rejects.toThrow('db down');
    expect(listener).not.toHaveBeenCalled();
    expect(svc.get('features.chat')).toBe(true);
  });
});
