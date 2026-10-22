export interface ActiveBan {
  reason: string | null;
  expiresAt: Date | null;
}

export interface BanStore {
  findActiveBan(target: { userId?: string; ip?: string }): Promise<ActiveBan | null>;
}
