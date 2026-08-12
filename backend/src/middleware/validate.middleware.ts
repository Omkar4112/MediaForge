import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/AppError';

const uuidSchema = z.string().uuid();

export function validateProcessingIdParam(req: Request, _res: Response, next: NextFunction): void {
  const result = uuidSchema.safeParse(req.params.processingId);
  if (!result.success) {
    next(new AppError(400, 'processingId must be a valid UUID'));
    return;
  }
  next();
}
