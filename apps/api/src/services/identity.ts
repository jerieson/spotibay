import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import {
  adjectives,
  animals,
  avatarBackgrounds,
  avatarStyles,
  SESSION_MAX_AGE_SEC,
  type Avatar,
} from '@spotibay/shared';

export interface UserRecord {
  id: string;
  displayName: string;
  avatar: Avatar;
  createdAt: Date;
  lastSeenAt: Date;
  bannedUntil: Date | null;
  /** Session tokens carry this; bumping it signs the user out everywhere. */
  sessionVersion: number;
}

export interface UserStore {
  create(input: {
    displayName: string;
    avatar: Avatar;
    recoveryCodeHash: string;
  }): Promise<UserRecord>;
  findById(id: string): Promise<UserRecord | null>;
  findByRecoveryHash(hash: string): Promise<UserRecord | null>;
  /** Replaces the recovery hash and bumps the session version; resolves the new version, or `null` if the user is gone. */
  rotateRecoveryHash(id: string, hash: string): Promise<number | null>;
  updateProfile(
    id: string,
    patch: { displayName?: string; avatar?: Avatar },
  ): Promise<UserRecord | null>;
  touch(id: string): Promise<void>;
}

export interface SessionClaims {
  userId: string;
  issuedAt: Date;
  sessionVersion: number;
}

export interface IdentityConfig {
  jwtSecret: string;
  recoveryHmacSecret: string;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_CODE_LENGTH = 16;

function pick<T>(items: readonly T[]): T {
  return items[randomInt(items.length)] as T;
}

export function randomDisplayName(): string {
  return `${pick(adjectives)} ${pick(animals)}`;
}

export function randomAvatar(): Avatar {
  return {
    style: pick(avatarStyles),
    seed: randomBytes(6).toString('hex'),
    options: { backgroundColor: pick(avatarBackgrounds) },
  };
}

/** 80 random bits as 16 base32 chars, grouped `XXXX-XXXX-XXXX-XXXX`. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g)!.join('-');
}

/** Uppercases and strips separators; returns null if the result cannot be a valid code. */
export function normalizeRecoveryCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, '');
  if (clean.length !== RECOVERY_CODE_LENGTH) return null;
  return [...clean].every((c) => BASE32.includes(c)) ? clean : null;
}

export function createIdentityService(
  users: UserStore,
  config: IdentityConfig,
  now: () => Date = () => new Date(),
) {
  const jwtKey = new TextEncoder().encode(config.jwtSecret);

  function hashRecoveryCode(normalized: string): string {
    return createHmac('sha256', config.recoveryHmacSecret).update(normalized).digest('hex');
  }

  async function verifySession(token: string): Promise<SessionClaims | null> {
    try {
      const { payload } = await jwtVerify(token, jwtKey, {
        algorithms: ['HS256'],
        currentDate: now(),
      });
      if (!payload.sub || payload.iat === undefined) return null;
      // Tokens from before session versions existed carry none; they match the starting version.
      const sv = payload.sv ?? 0;
      if (typeof sv !== 'number') return null;
      return { userId: payload.sub, issuedAt: new Date(payload.iat * 1000), sessionVersion: sv };
    } catch {
      return null;
    }
  }

  return {
    async startGuest(): Promise<{ user: UserRecord; recoveryCode: string }> {
      const recoveryCode = generateRecoveryCode();
      const user = await users.create({
        displayName: randomDisplayName(),
        avatar: randomAvatar(),
        recoveryCodeHash: hashRecoveryCode(normalizeRecoveryCode(recoveryCode)!),
      });
      return { user, recoveryCode };
    },

    async recover(code: string): Promise<UserRecord | null> {
      const normalized = normalizeRecoveryCode(code);
      if (!normalized) return null;
      return users.findByRecoveryHash(hashRecoveryCode(normalized));
    },

    /** A new recovery code; every existing session of the user stops working. */
    async regenerateRecoveryCode(
      userId: string,
    ): Promise<{ recoveryCode: string; sessionVersion: number } | null> {
      const recoveryCode = generateRecoveryCode();
      const sessionVersion = await users.rotateRecoveryHash(
        userId,
        hashRecoveryCode(normalizeRecoveryCode(recoveryCode)!),
      );
      return sessionVersion === null ? null : { recoveryCode, sessionVersion };
    },

    updateProfile: (id: string, patch: { displayName?: string; avatar?: Avatar }) =>
      users.updateProfile(id, patch),
    touch: (id: string) => users.touch(id),
    verifySession,

    signSession(user: Pick<UserRecord, 'id' | 'sessionVersion'>): Promise<string> {
      const issuedAt = Math.floor(now().getTime() / 1000);
      return new SignJWT({ sv: user.sessionVersion })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + SESSION_MAX_AGE_SEC)
        .sign(jwtKey);
    },

    /** The signed-in user for a session token, or `null` if it is invalid, revoked or the user is gone. */
    async resolveSession(
      token: string,
    ): Promise<{ user: UserRecord; claims: SessionClaims } | null> {
      const claims = await verifySession(token);
      if (!claims) return null;
      const user = await users.findById(claims.userId);
      if (!user || user.sessionVersion !== claims.sessionVersion) return null;
      return { user, claims };
    },
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
