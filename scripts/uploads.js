const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mimeType: 'image/jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { ext: '.png', mimeType: 'image/png' };
  }

  // GIF87a / GIF89a
  const header6 = buffer.subarray(0, 6).toString('ascii');
  if (header6 === 'GIF87a' || header6 === 'GIF89a') {
    return { ext: '.gif', mimeType: 'image/gif' };
  }

  // WEBP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: '.webp', mimeType: 'image/webp' };
  }

  return null;
}

function parseAndValidateImageUpload({ dataUrl, maxBytes = DEFAULT_MAX_IMAGE_BYTES } = {}) {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
    return { ok: false, status: 400, error: 'Select a valid image file to upload.' };
  }

  const match = dataUrl.trim().match(DATA_URL_PATTERN);
  if (!match) {
    return { ok: false, status: 400, error: 'Only JPEG, PNG, WebP, or GIF image files are supported.' };
  }

  const base64Body = match[2].replace(/\s+/g, '');
  const buffer = Buffer.from(base64Body, 'base64');
  if (!buffer.length) {
    return { ok: false, status: 400, error: 'Uploaded image file is empty.' };
  }
  if (buffer.length > maxBytes) {
    return { ok: false, status: 413, error: 'Image is too large. Please choose a smaller photo.' };
  }

  const detected = detectImageType(buffer);
  if (!detected) {
    return { ok: false, status: 400, error: 'Uploaded file is not a valid JPEG, PNG, WebP, or GIF image.' };
  }

  return {
    ok: true,
    buffer,
    ext: detected.ext,
    mimeType: detected.mimeType
  };
}

function createImageUploadManager({
  uploadDir = path.resolve(__dirname, '..', 'uploads', 'products'),
  maxBytes = DEFAULT_MAX_IMAGE_BYTES
} = {}) {
  async function saveImage({ dataUrl }) {
    const parsed = parseAndValidateImageUpload({ dataUrl, maxBytes });
    if (!parsed.ok) return parsed;

    await fs.promises.mkdir(uploadDir, { recursive: true });
    const filename = `${crypto.randomUUID()}${parsed.ext}`;
    const filePath = path.join(uploadDir, filename);
    await fs.promises.writeFile(filePath, parsed.buffer);

    return {
      ok: true,
      url: `/uploads/products/${filename}`,
      mimeType: parsed.mimeType,
      bytes: parsed.buffer.length
    };
  }

  return { saveImage };
}

module.exports = {
  DEFAULT_MAX_IMAGE_BYTES,
  detectImageType,
  parseAndValidateImageUpload,
  createImageUploadManager
};
