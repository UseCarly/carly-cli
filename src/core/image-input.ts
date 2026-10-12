import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

export const imageBase64 = z.preprocess((value) => {
  if (typeof value !== 'string' || !value.startsWith('@')) return value;
  const file = value.slice(1);
  if (statSync(file).size > 512 * 1024) throw new Error('The logo must be under 512 KB.');
  return readFileSync(file).toString('base64');
}, z.string().max(700_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'Expected base64 image bytes or @image-file'));
export const imageMimeType = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
