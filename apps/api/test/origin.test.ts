import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connected, createHarness, type Harness } from './helpers/harness.js';

const SITE = 'https://spotibay.test';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ allowedOrigin: SITE });
});
afterAll(async () => {
  await h.close();
});

describe('origin check', () => {
  it('refuses state-changing requests from other origins', async () => {
    const guest = await h.guest();
    const post = (origin: string) =>
      fetch(`${h.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { cookie: guest.cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Origin room' }),
      });
    expect((await post('https://evil.spotibay.test')).status).toBe(403);
    expect((await post(SITE)).status).toBe(201);
    // Reads stay open, and requests without an Origin are not from another site's page.
    const read = await fetch(`${h.baseUrl}/api/me`, {
      headers: { cookie: guest.cookie, origin: 'https://evil.test' },
    });
    expect(read.status).toBe(200);
  });

  it('refuses socket handshakes from other origins', async () => {
    const guest = await h.guest();
    await expect(
      connected(h.connect(guest.cookie, { origin: 'https://evil.test' })),
    ).rejects.toThrow();
    await expect(connected(h.connect(guest.cookie, { origin: SITE }))).resolves.toBeUndefined();
  });
});
