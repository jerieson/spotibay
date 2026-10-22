import { Router } from 'express';
import {
  recoverBodySchema,
  updateMeBodySchema,
  type Avatar,
  type SessionResponse,
  type User,
} from '@spotibay/shared';
import { validateBody } from '../lib/validate.js';
import { containsFilteredWord } from '../lib/word-filter.js';
import { requireUser, setSessionCookie } from '../middleware/session.js';
import type { IdentityService, UserRecord } from '../services/identity.js';

export interface SessionRouterOptions {
  identity: IdentityService;
  wordFilter: () => readonly string[];
  secureCookie: boolean;
}

export function toPublicUser(user: UserRecord): User {
  return {
    id: user.id,
    displayName: user.displayName,
    avatar: user.avatar,
    createdAt: user.createdAt.toISOString(),
  };
}

export function createSessionRouter({ identity, wordFilter, secureCookie }: SessionRouterOptions) {
  const router = Router();

  router.post('/session', async (req, res) => {
    if (req.user) {
      const body: SessionResponse = { user: toPublicUser(req.user), recoveryCode: null };
      res.json(body);
      return;
    }
    const { user, recoveryCode } = await identity.startGuest();
    setSessionCookie(res, await identity.signSession(user.id), secureCookie);
    const body: SessionResponse = { user: toPublicUser(user), recoveryCode };
    res.status(201).json(body);
  });

  router.post('/session/recover', validateBody(recoverBodySchema), async (req, res) => {
    const user = await identity.recover(req.body.code);
    if (!user) {
      res.status(404).json({ error: 'invalid_recovery_code' });
      return;
    }
    setSessionCookie(res, await identity.signSession(user.id), secureCookie);
    await identity.touch(user.id);
    const body: SessionResponse = { user: toPublicUser(user), recoveryCode: null };
    res.json(body);
  });

  router.post('/session/recovery-code', requireUser, async (req, res) => {
    const recoveryCode = await identity.regenerateRecoveryCode(req.user!.id);
    res.json({ recoveryCode });
  });

  router.get('/me', requireUser, (req, res) => {
    res.json({ user: toPublicUser(req.user!) });
  });

  router.patch('/me', requireUser, validateBody(updateMeBodySchema), async (req, res) => {
    const { displayName, avatar } = req.body;
    if (displayName !== undefined && containsFilteredWord(displayName, wordFilter())) {
      res.status(422).json({ error: 'name_not_allowed', message: 'That name is not allowed' });
      return;
    }
    const patch: { displayName?: string; avatar?: Avatar } = {};
    if (displayName !== undefined) patch.displayName = displayName;
    if (avatar !== undefined) patch.avatar = avatar;
    const user = await identity.updateProfile(req.user!.id, patch);
    if (!user) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ user: toPublicUser(user) });
  });

  return router;
}
