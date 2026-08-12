import { Router } from 'express';
import { uploadMiddleware } from '../middleware/upload.middleware';
import { validateProcessingIdParam } from '../middleware/validate.middleware';
import { uploadImage, getStatus, getResults } from '../controllers/image.controller';

const router = Router();

router.post('/images', uploadMiddleware, uploadImage);
router.get('/images/:processingId/status', validateProcessingIdParam, getStatus);
router.get('/images/:processingId/results', validateProcessingIdParam, getResults);

export default router;
