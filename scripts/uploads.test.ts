import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectImageType,
  parseAndValidateImageUpload,
  createImageUploadManager
} = require('./uploads.js');

const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('detectImageType identifies PNG, JPEG, GIF, and rejects non-images', () => {
  const pngBuf = Buffer.from(PNG_1X1_BASE64, 'base64');
  assert.deepEqual(detectImageType(pngBuf), { ext: '.png', mimeType: 'image/png' });

  const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(detectImageType(jpgBuf), { ext: '.jpg', mimeType: 'image/jpeg' });

  const textBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(detectImageType(textBuf), null);
});

test('parseAndValidateImageUpload rejects SVG, forged MIME headers, and oversized files', () => {
  const svgRes = parseAndValidateImageUpload({
    dataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg></svg>').toString('base64')
  });
  assert.equal(svgRes.ok, false);
  assert.equal(svgRes.status, 400);

  const forgedRes = parseAndValidateImageUpload({
    dataUrl: 'data:image/png;base64,' + Buffer.from('not really a png').toString('base64')
  });
  assert.equal(forgedRes.ok, false);
  assert.equal(forgedRes.status, 400);

  const validRes = parseAndValidateImageUpload({
    dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`
  });
  assert.equal(validRes.ok, true);
  assert.equal(validRes.ext, '.png');

  const tooLargeRes = parseAndValidateImageUpload({
    dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
    maxBytes: 10
  });
  assert.equal(tooLargeRes.ok, false);
  assert.equal(tooLargeRes.status, 413);
});

test('createImageUploadManager writes valid image to disk and returns public path', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zawadi-upload-test-'));
  try {
    const manager = createImageUploadManager({ uploadDir: tmpDir });
    const result = await manager.saveImage({ dataUrl: `data:image/png;base64,${PNG_1X1_BASE64}` });
    assert.equal(result.ok, true);
    assert.match(result.url, /^\/uploads\/products\/[0-9a-f-]+\.png$/);
    const savedFilename = path.basename(result.url);
    const stat = await fs.promises.stat(path.join(tmpDir, savedFilename));
    assert.ok(stat.size > 0);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});
