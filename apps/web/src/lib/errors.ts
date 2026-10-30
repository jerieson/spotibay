export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** When a used-up allowance (like today's searches) comes back. */
    readonly resetAt: Date | null = null,
  ) {
    super(message);
  }
}

const OFFLINE = "Can't connect. Check your internet connection and try again.";
const FALLBACK = 'Something went wrong. Try again.';

/** What to say for a status when the server didn't explain (a proxy's HTML error page, say). */
function statusMessage(status: number): string {
  if (status === 429) return "You're going a bit fast. Wait a moment and try again.";
  if (status === 401 || status === 403) return "You're not allowed to do that.";
  if (status === 404) return "That couldn't be found. It may have been removed.";
  if (status === 502 || status === 503 || status === 504)
    return 'Spotibay is having trouble right now. Try again in a moment.';
  if (status >= 500) return 'Something went wrong on our side. Try again.';
  return FALLBACK;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * Throws for a failed response, keeping the server's own message when it sent one. Network
 * failures (`fetch` rejecting) should go through `networkError`.
 */
export async function throwForResponse(res: Response): Promise<never> {
  const json: unknown = await res.json().catch(() => null);
  const body = (json ?? {}) as { error?: unknown; message?: unknown; resetAt?: unknown };
  const resetAt = typeof body.resetAt === 'string' ? new Date(body.resetAt) : null;
  throw new ApiError(
    res.status,
    typeof body.error === 'string' ? body.error : 'unknown',
    typeof body.message === 'string' && body.message ? body.message : statusMessage(res.status),
    resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null,
  );
}

export function networkError(): ApiError {
  return new ApiError(0, 'network', OFFLINE);
}

/** A message fit to show anyone, for any error a request or the app can throw. */
export function friendlyError(err: unknown, fallback = FALLBACK): string {
  if (err instanceof ApiError) {
    if (err.resetAt) return `${err.message} Back at ${timeFormat.format(err.resetAt)}.`;
    return err.message;
  }
  // `fetch` rejects with a TypeError when the network is down.
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return OFFLINE;
  return fallback;
}
