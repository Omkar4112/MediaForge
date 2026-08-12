import { pool } from '../config/db';

export interface ImageRecord {
  id: string;
  original_filename: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  width: number | null;
  height: number | null;
  phash: string | null;
  image_type: string;
  created_at: Date;
}

export interface CreateImageInput {
  originalFilename: string;
  storagePath: string;
  mimeType: string;
  fileSize: number;
  imageType?: string;
}

export async function createImage(input: CreateImageInput): Promise<ImageRecord> {
  const imageType = input.imageType || 'generic';
  const result = await pool.query<ImageRecord>(
    `INSERT INTO images (original_filename, storage_path, mime_type, file_size, image_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.originalFilename, input.storagePath, input.mimeType, input.fileSize, imageType]
  );
  return result.rows[0];
}

export async function updateImageDimensionsAndHash(
  imageId: string,
  width: number,
  height: number,
  phash: string | null
): Promise<void> {
  await pool.query(
    `UPDATE images SET width = $2, height = $3, phash = $4 WHERE id = $1`,
    [imageId, width, height, phash]
  );
}

export async function findImageById(imageId: string): Promise<ImageRecord | null> {
  const result = await pool.query<ImageRecord>('SELECT * FROM images WHERE id = $1', [imageId]);
  return result.rows[0] ?? null;
}

export async function findRecentImagesWithHash(excludeImageId: string, limit = 500): Promise<ImageRecord[]> {
  const result = await pool.query<ImageRecord>(
    `SELECT * FROM images
     WHERE id != $1 AND phash IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $2`,
    [excludeImageId, limit]
  );
  return result.rows;
}
