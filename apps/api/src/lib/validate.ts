import type { RequestHandler } from 'express';
import type { z } from 'zod';

export function validateBody<T extends z.ZodType>(
  schema: T,
): RequestHandler<Record<string, string>, unknown, z.infer<T>> {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', message: parsed.error.issues[0]?.message });
      return;
    }
    req.body = parsed.data;
    next();
  };
}

export function validateQuery<T extends z.ZodType>(schema: T): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', message: parsed.error.issues[0]?.message });
      return;
    }
    res.locals.query = parsed.data;
    next();
  };
}
