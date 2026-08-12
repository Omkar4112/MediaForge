import multer from 'multer';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

const storage = multer.memoryStorage();

function fileFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) {
  if (!env.upload.allowedMimeTypes.includes(file.mimetype)) {
    cb(new AppError(400, `Unsupported MIME type: ${file.mimetype}`));
    return;
  }
  cb(null, true);
}

export const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: env.upload.maxFileSizeBytes,
    files: 1,
  },
  fileFilter,
}).single('image');
