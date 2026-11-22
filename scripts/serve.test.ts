import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAppServer } = require('./serve.js');

async function startTestServer() {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('serves index.html with HTML content type on /', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    const html = await response.text();
    assert.match(html, /Zawadi Gift Shop/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('serves manifest.json and rejects unsupported methods and traversal', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const manifestRes = await fetch(`${baseUrl}/manifest.json`);
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers.get('content-type') || '', /application\/json/);

    const postRes = await fetch(`${baseUrl}/`, { method: 'POST' });
    assert.equal(postRes.status, 405);

    const notFoundRes = await fetch(`${baseUrl}/does-not-exist.txt`);
    assert.equal(notFoundRes.status, 404);

    const traversalStatus = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/../../etc/passwd`, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(traversalStatus, 404);

    const badUriStatus = await new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}/%E0%A4%A`, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(badUriStatus, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
