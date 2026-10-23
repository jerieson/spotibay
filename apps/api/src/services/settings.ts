import { EventEmitter } from 'node:events';
import {
  isSettingKey,
  settingKeys,
  settingsDefaults,
  settingsSchemas,
  type SettingKey,
  type SettingsValues,
} from '@spotibay/shared';
import { db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import { redis } from '../redis.js';

export const SETTINGS_VERSION_KEY = 'settings:cache:version';

export interface SettingsStore {
  loadAll(): Promise<Map<string, unknown>>;
  upsert(key: SettingKey, value: unknown, adminId: string | null): Promise<void>;
}

export interface VersionCounter {
  bump(): Promise<number>;
}

export interface SettingChange<K extends SettingKey = SettingKey> {
  key: K;
  value: SettingsValues[K];
  previous: SettingsValues[K];
  version: number;
}

export class SettingsValidationError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export function createSettingsService(store: SettingsStore, versionCounter: VersionCounter) {
  const events = new EventEmitter();
  let cache: SettingsValues = { ...settingsDefaults };
  let version = 0;
  let loaded = false;

  async function load(): Promise<void> {
    const rows = await store.loadAll();
    const next: Record<string, unknown> = { ...settingsDefaults };
    for (const key of settingKeys) {
      if (!rows.has(key)) continue;
      const parsed = settingsSchemas[key].safeParse(rows.get(key));
      // A stored value that no longer validates falls back to the default.
      if (parsed.success) next[key] = parsed.data;
    }
    cache = next as SettingsValues;
    loaded = true;
  }

  function get<K extends SettingKey>(key: K): SettingsValues[K] {
    if (!loaded) throw new Error('settings service not loaded; call load() first');
    return cache[key];
  }

  async function set<K extends SettingKey>(
    key: K,
    value: unknown,
    adminId: string | null,
  ): Promise<SettingChange<K>> {
    if (!isSettingKey(key)) throw new SettingsValidationError(key, `unknown setting: ${key}`);
    const parsed = settingsSchemas[key].safeParse(value);
    if (!parsed.success) {
      throw new SettingsValidationError(key, parsed.error.issues.map((i) => i.message).join('; '));
    }
    const next = parsed.data as SettingsValues[K];
    const previous = get(key);
    await store.upsert(key, next, adminId);
    cache = { ...cache, [key]: next };
    version = await versionCounter.bump();
    const change: SettingChange<K> = { key, value: next, previous, version };
    events.emit('change', change);
    return change;
  }

  function all(): SettingsValues {
    if (!loaded) throw new Error('settings service not loaded; call load() first');
    return { ...cache };
  }

  function onChange(listener: (change: SettingChange) => void): () => void {
    events.on('change', listener);
    return () => events.off('change', listener);
  }

  return {
    load,
    get,
    set,
    all,
    onChange,
    get version() {
      return version;
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;

const dbStore: SettingsStore = {
  async loadAll() {
    const rows = await db.select().from(appSettings);
    return new Map(rows.map((r) => [r.key, r.value]));
  },
  async upsert(key, value, adminId) {
    await db
      .insert(appSettings)
      .values({ key, value, updatedByAdminId: adminId })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: new Date(), updatedByAdminId: adminId },
      });
  },
};

const redisVersion: VersionCounter = {
  bump: () => redis.incr(SETTINGS_VERSION_KEY),
};

export const settings = createSettingsService(dbStore, redisVersion);
