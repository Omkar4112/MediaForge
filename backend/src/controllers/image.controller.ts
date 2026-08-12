import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import * as imageService from '../services/image.service';

export const uploadImage = asyncHandler(async (req: Request, res: Response) => {
  const imageType = typeof req.body.imageType === 'string' ? req.body.imageType : (typeof req.query.imageType === 'string' ? req.query.imageType : undefined);
  const result = await imageService.handleImageUpload(req.file as Express.Multer.File, imageType);
  res.status(202).json(result);
});

export const getStatus = asyncHandler(async (req: Request, res: Response) => {
  const result = await imageService.getJobStatus(req.params.processingId);
  res.status(200).json(result);
});

export const getResults = asyncHandler(async (req: Request, res: Response) => {
  const result = await imageService.getJobResults(req.params.processingId);
  res.status(200).json(result);
});
