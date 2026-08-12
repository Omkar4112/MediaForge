import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file exceeds the maximum allowed size' : err.message;
    res.status(400).json({ error: message, code: err.code });
    return;
  }

  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error('Non-operational AppError', { error: err.message, stack: err.stack });
    }
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.originalUrl });
  res.status(500).json({ error: 'Internal Server Error' });
}
