import type { AuditEntry } from '@spotibay/shared';

export interface AuditInput {
  adminId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

export interface AuditFilter {
  action?: string;
  targetType?: string;
  before?: number;
  limit: number;
}

export interface AuditStore {
  insert(input: AuditInput): Promise<void>;
  list(filter: AuditFilter): Promise<AuditEntry[]>;
}

export function createAuditService(store: AuditStore) {
  return {
    record: (input: AuditInput) => store.insert(input),
    async list(filter: AuditFilter): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
      // One extra row tells us whether another page exists.
      const rows = await store.list({ ...filter, limit: filter.limit + 1 });
      const entries = rows.slice(0, filter.limit);
      const nextBefore = rows.length > filter.limit ? (entries.at(-1)?.id ?? null) : null;
      return { entries, nextBefore };
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
