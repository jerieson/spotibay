import {
  healthResponseSchema,
  meResponseSchema,
  recoveryCodeResponseSchema,
  sessionResponseSchema,
  type HealthResponse,
  type SessionResponse,
  type UpdateMeBody,
  type User,
} from '@spotibay/shared';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T extends z.ZodType>(
  schema: T,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<z.infer<T>> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (json ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      res.status,
      err.error ?? 'unknown',
      err.message ?? `Request failed (${res.status})`,
    );
  }
  return schema.parse(json);
}

export async function fetchHealth(): Promise<HealthResponse> {
  return request(healthResponseSchema, '/api/health');
}

export function startSession(): Promise<SessionResponse> {
  return request(sessionResponseSchema, '/api/session', { method: 'POST' });
}

export function recoverSession(code: string): Promise<SessionResponse> {
  return request(sessionResponseSchema, '/api/session/recover', { method: 'POST', body: { code } });
}

export async function regenerateRecoveryCode(): Promise<string> {
  const res = await request(recoveryCodeResponseSchema, '/api/session/recovery-code', {
    method: 'POST',
  });
  return res.recoveryCode;
}

export async function updateMe(body: UpdateMeBody): Promise<User> {
  const res = await request(meResponseSchema, '/api/me', { method: 'PATCH', body });
  return res.user;
}
