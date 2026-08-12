import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import healthRoutes from './routes/health.routes';
import imageRoutes from './routes/image.routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.middleware';
import { logger } from './utils/logger';

export function createApp(): Application {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json());
  app.use(
    morgan('combined', {
      stream: { write: (message: string) => logger.info(message.trim()) },
    })
  );

  app.use(express.static(path.join(__dirname, '../public')));
  app.use('/', healthRoutes);
  app.use('/api/v1', imageRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
