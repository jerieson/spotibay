import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adjectives,
  animals,
  avatarSchema,
  DISPLAY_NAME_MAX,
  SESSION_COOKIE,
  sessionResponseSchema,
} from '@spotibay/shared';
import { createApp } from '../src/app.js';
import { containsFilteredWord } from '../src/lib/word-filter.js';
import type { ActiveBan, BanStore } from '../src/services/bans.js';
import {
  createIdentityService,
  generateRecoveryCode,
  normalizeRecoveryCode,
  randomAvatar,
  randomDisplayName,
  type UserRecord,
  type UserStore,
} from '../src/services/identity.js';

const config = {
  jwtSecret: 'j'.repeat(40),
  recoveryHmacSecret: 'r'.repeat(40),
};

function memoryStore() {
  const users = new Map<string, UserRecord & { recoveryCodeHash: string }>();
  let n = 0;
  const store: UserStore = {
    async create(input) {
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const now = new Date();
      const row = {
        id,
        ...input,
        createdAt: now,
        lastSeenAt: now,
        bannedUntil: null,
        sessionVersion: 0,
      };
      users.set(id, row);
      return row;
    },
    findById: async (id) => users.get(id) ?? null,
    findByRecoveryHash: async (hash) =>
      [...users.values()].find((u) => u.recoveryCodeHash === hash) ?? null,
    async rotateRecoveryHash(id, hash) {
      const row = users.get(id);
      if (!row) return null;
      row.recoveryCodeHash = hash;
      return ++row.sessionVersion;
    },
    async updateProfile(id, patch) {
      const row = users.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    async touch(id) {
      users.get(id)!.lastSeenAt = new Date();
    },
  };
  return { store, users };
}

function setup(opts: { wordFilter?: string[]; ban?: ActiveBan | null } = {}) {
  const { store, users } = memoryStore();
  const identity = createIdentityService(store, config);
  const bans: BanStore = { findActiveBan: async () => opts.ban ?? null };
  const app = createApp({
    identity,
    bans,
    wordFilter: () => opts.wordFilter ?? [],
    secureCookie: false,
  });
  return { app, identity, users };
}

function sessionCookie(res: request.Response): string {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const found = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  expect(found).toBeDefined();
  return found!.split(';')[0]!;
}

describe('generators', () => {
  it('produces display names within the length limit for every combination', () => {
    for (const a of adjectives) {
      for (const b of animals) expect(`${a} ${b}`.length).toBeLessThanOrEqual(DISPLAY_NAME_MAX);
    }
    expect(randomDisplayName()).toMatch(/^\w+ \w+$/);
  });

  it('produces valid avatars', () => {
    for (let i = 0; i < 20; i++) expect(avatarSchema.safeParse(randomAvatar()).success).toBe(true);
  });

  it('formats recovery codes as 4 groups of 4 base32 chars', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it('normalizes recovery codes leniently but rejects bad ones', () => {
    expect(normalizeRecoveryCode('abcd-efgh-2345-67ab')).toBe('ABCDEFGH234567AB');
    expect(normalizeRecoveryCode(' ABCD EFGH 2345 67AB ')).toBe('ABCDEFGH234567AB');
    expect(normalizeRecoveryCode('ABCD-EFGH')).toBeNull();
    expect(normalizeRecoveryCode('ABCD-EFGH-1111-1111')).toBeNull();
  });
});

describe('word filter', () => {
  it('matches case-insensitively, through separators and leetspeak', () => {
    expect(containsFilteredWord('Big BADWORD guy', ['badword'])).toBe(true);
    expect(containsFilteredWord('b.a.d-w0rd', ['badword'])).toBe(true);
    expect(containsFilteredWord('Sleepy Otter', ['badword'])).toBe(false);
    expect(containsFilteredWord('anything', [''])).toBe(false);
  });
});

describe('POST /api/session', () => {
  it('creates a guest, sets an httpOnly cookie and returns the recovery code once', async () => {
    const { app, users } = setup();
    const res = await request(app).post('/api/session');
    expect(res.status).toBe(201);
    const body = sessionResponseSchema.parse(res.body);
    expect(body.recoveryCode).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(users.size).toBe(1);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=31536000/);
    // The raw code is never stored.
    const stored = [...users.values()][0]!.recoveryCodeHash;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(body.recoveryCode!.replace(/-/g, '')).not.toBe(stored);
  });

  it('reuses the session when the cookie is valid', async () => {
    const { app, users } = setup();
    const first = await request(app).post('/api/session');
    const second = await request(app).post('/api/session').set('Cookie', sessionCookie(first));
    expect(second.status).toBe(200);
    expect(second.body.recoveryCode).toBeNull();
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(users.size).toBe(1);
  });

  it('creates a new guest when the cookie is garbage or the user is gone', async () => {
    const { app, users } = setup();
    const res = await request(app).post('/api/session').set('Cookie', `${SESSION_COOKIE}=nope`);
    expect(res.status).toBe(201);
    const cookie = sessionCookie(res);
    users.clear();
    const again = await request(app).post('/api/session').set('Cookie', cookie);
    expect(again.status).toBe(201);
  });

  it('rejects a token signed with another secret', async () => {
    const { app } = setup();
    const other = createIdentityService(memoryStore().store, {
      ...config,
      jwtSecret: 'x'.repeat(40),
    });
    const token = await other.signSession({
      id: '00000000-0000-4000-8000-000000000001',
      sessionVersion: 0,
    });
    const res = await request(app).get('/api/me').set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(401);
  });
});

describe('recovery', () => {
  let ctx: ReturnType<typeof setup>;
  let code: string;
  let userId: string;

  beforeEach(async () => {
    ctx = setup();
    const res = await request(ctx.app).post('/api/session');
    code = res.body.recoveryCode;
    userId = res.body.user.id;
  });

  it('restores the same account in a fresh browser, tolerating formatting', async () => {
    const res = await request(ctx.app)
      .post('/api/session/recover')
      .send({ code: code.toLowerCase().replace(/-/g, ' ') });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userId);
    const me = await request(ctx.app).get('/api/me').set('Cookie', sessionCookie(res));
    expect(me.body.user.id).toBe(userId);
  });

  it('rejects unknown and malformed codes', async () => {
    const unknown = await request(ctx.app)
      .post('/api/session/recover')
      .send({ code: 'AAAA-AAAA-AAAA-AAAA' });
    expect(unknown.status).toBe(404);
    const malformed = await request(ctx.app).post('/api/session/recover').send({ code: 'abc' });
    expect(malformed.status).toBe(404);
    const missing = await request(ctx.app).post('/api/session/recover').send({});
    expect(missing.status).toBe(400);
  });

  it('regenerating invalidates the old code', async () => {
    const login = await request(ctx.app).post('/api/session/recover').send({ code });
    const regen = await request(ctx.app)
      .post('/api/session/recovery-code')
      .set('Cookie', sessionCookie(login));
    expect(regen.status).toBe(200);
    expect(regen.body.recoveryCode).not.toBe(code);
    expect((await request(ctx.app).post('/api/session/recover').send({ code })).status).toBe(404);
    const fresh = await request(ctx.app)
      .post('/api/session/recover')
      .send({ code: regen.body.recoveryCode });
    expect(fresh.body.user.id).toBe(userId);
  });

  it('regenerating signs out other devices but keeps this one', async () => {
    const original = await request(ctx.app).post('/api/session/recover').send({ code });
    const otherDevice = sessionCookie(original);
    const thisDevice = sessionCookie(
      await request(ctx.app).post('/api/session/recover').send({ code }),
    );
    const regen = await request(ctx.app)
      .post('/api/session/recovery-code')
      .set('Cookie', thisDevice);
    expect(regen.status).toBe(200);
    expect((await request(ctx.app).get('/api/me').set('Cookie', otherDevice)).status).toBe(401);
    const me = await request(ctx.app).get('/api/me').set('Cookie', sessionCookie(regen));
    expect(me.body.user.id).toBe(userId);
  });

  it('requires a session to regenerate', async () => {
    const res = await request(ctx.app).post('/api/session/recovery-code');
    expect(res.status).toBe(401);
  });
});

describe('/api/me', () => {
  it('requires a session', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/me')).status).toBe(401);
    expect((await request(app).patch('/api/me').send({ displayName: 'Hello' })).status).toBe(401);
  });

  async function login(app: ReturnType<typeof setup>['app']) {
    return sessionCookie(await request(app).post('/api/session'));
  }

  it('updates name and avatar', async () => {
    const { app } = setup();
    const cookie = await login(app);
    const avatar = { style: 'bottts', seed: 'abc', options: { backgroundColor: 'ceff00' } };
    const res = await request(app)
      .patch('/api/me')
      .set('Cookie', cookie)
      .send({ displayName: '  DJ Fox  ', avatar });
    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe('DJ Fox');
    expect(res.body.user.avatar).toEqual(avatar);
    const me = await request(app).get('/api/me').set('Cookie', cookie);
    expect(me.body.user.displayName).toBe('DJ Fox');
  });

  it.each([
    ['too short', { displayName: 'A' }],
    ['too short after trim', { displayName: ' a ' }],
    ['too long', { displayName: 'x'.repeat(25) }],
    ['control characters', { displayName: 'hi\u0000there' }],
    ['empty patch', {}],
    ['unknown avatar style', { avatar: { style: 'evil', seed: 'a', options: {} } }],
    [
      'bad background',
      { avatar: { style: 'bottts', seed: 'a', options: { backgroundColor: 'red' } } },
    ],
    ['extra avatar options', { avatar: { style: 'bottts', seed: 'a', options: { x: 1 } } }],
  ])('rejects %s', async (_label, body) => {
    const { app } = setup();
    const cookie = await login(app);
    const res = await request(app).patch('/api/me').set('Cookie', cookie).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('accepts names at the length boundaries', async () => {
    const { app } = setup();
    const cookie = await login(app);
    for (const name of ['Ab', 'x'.repeat(24)]) {
      const res = await request(app)
        .patch('/api/me')
        .set('Cookie', cookie)
        .send({ displayName: name });
      expect(res.status).toBe(200);
    }
  });

  it('applies the word filter', async () => {
    const { app } = setup({ wordFilter: ['badword'] });
    const cookie = await login(app);
    const res = await request(app)
      .patch('/api/me')
      .set('Cookie', cookie)
      .send({ displayName: 'B4dW0rd' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('name_not_allowed');
    const ok = await request(app)
      .patch('/api/me')
      .set('Cookie', cookie)
      .send({ displayName: 'Nice Name' });
    expect(ok.status).toBe(200);
  });

  it('rejects malformed JSON', async () => {
    const { app } = setup();
    const cookie = await login(app);
    const res = await request(app)
      .patch('/api/me')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send('{nope');
    expect(res.status).toBe(400);
  });
});

describe('ban check', () => {
  it('blocks requests matching an active ban', async () => {
    const { app } = setup({ ban: { reason: 'spam', expiresAt: null } });
    const res = await request(app).post('/api/session');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'banned', reason: 'spam', until: null });
  });

  it('blocks a user whose bannedUntil is in the future, but not once expired', async () => {
    const { app, users } = setup();
    const created = await request(app).post('/api/session');
    const cookie = sessionCookie(created);
    const user = users.get(created.body.user.id)!;
    user.bannedUntil = new Date(Date.now() + 60_000);
    const blocked = await request(app).get('/api/me').set('Cookie', cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('banned');
    user.bannedUntil = new Date(Date.now() - 1000);
    expect((await request(app).get('/api/me').set('Cookie', cookie)).status).toBe(200);
  });

  it('passes the client IP (via trust proxy) to the ban store', async () => {
    const seen: Array<string | undefined> = [];
    const { store } = memoryStore();
    const app = createApp({
      identity: createIdentityService(store, config),
      bans: {
        findActiveBan: async ({ ip }) => {
          seen.push(ip);
          return null;
        },
      },
      secureCookie: false,
    });
    await request(app).post('/api/session').set('X-Forwarded-For', '203.0.113.7');
    expect(seen[0]).toBe('203.0.113.7');
  });

  it('does not block the health endpoint', async () => {
    const { store } = memoryStore();
    const app = createApp({
      identity: createIdentityService(store, config),
      bans: { findActiveBan: async () => ({ reason: null, expiresAt: null }) },
    });
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});
