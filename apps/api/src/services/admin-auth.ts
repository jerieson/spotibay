import { SignJWT, jwtVerify } from 'jose';
import { ADMIN_SESSION_MAX_AGE_SEC } from '@spotibay/shared';
import { verifyPassword } from '../lib/password.js';

export interface AdminRecord {
  id: string;
  username: string;
}

export interface AdminStore {
  /** Creates the admin or replaces its password hash. */
  upsert(username: string, passwordHash: string): Promise<AdminRecord>;
  findByUsername(username: string): Promise<(AdminRecord & { passwordHash: string }) | null>;
  findById(id: string): Promise<AdminRecord | null>;
  touchLogin(id: string): Promise<void>;
}

export interface AdminAuthOptions {
  store: AdminStore;
  jwtSecret: string;
  /** Both unset means the admin panel is switched off. */
  username?: string;
  passwordHash?: string;
  now?: () => Date;
}

const AUDIENCE = 'spotibay-admin';

export function createAdminAuth({
  store,
  jwtSecret,
  username,
  passwordHash,
  now = () => new Date(),
}: AdminAuthOptions) {
  // A separate audience keeps a guest session token from ever passing as an admin one.
  const key = new TextEncoder().encode(jwtSecret);
  const enabled = Boolean(username && passwordHash);

  /** Makes the stored admin match the environment. Call once on start. */
  async function sync(): Promise<void> {
    if (username && passwordHash) await store.upsert(username, passwordHash);
  }

  async function login(
    name: string,
    password: string,
  ): Promise<{ admin: AdminRecord; token: string } | null> {
    if (!enabled || name !== username) return null;
    const row = await store.findByUsername(name);
    if (!row || !(await verifyPassword(row.passwordHash, password))) return null;
    await store.touchLogin(row.id);
    const issuedAt = Math.floor(now().getTime() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(row.id)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ADMIN_SESSION_MAX_AGE_SEC)
      .sign(key);
    return { admin: { id: row.id, username: row.username }, token };
  }

  /** The admin a token belongs to, or `null` if it is missing, expired, forged or the admin is gone. */
  async function verify(token: string | undefined): Promise<AdminRecord | null> {
    if (!enabled || !token) return null;
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        audience: AUDIENCE,
        currentDate: now(),
      });
      if (!payload.sub) return null;
      const admin = await store.findById(payload.sub);
      return admin && admin.username === username ? admin : null;
    } catch {
      return null;
    }
  }

  return { enabled, sync, login, verify };
}

export type AdminAuth = ReturnType<typeof createAdminAuth>;
