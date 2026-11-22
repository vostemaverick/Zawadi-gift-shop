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

test('exposes push public key, validates subscribe, and requires owner auth for order-status push', async () => {
  const { createPushManager } = require('./push.js');
  const sent = [];
  const mockPushManager = createPushManager({
    webPushClient: {
      generateVAPIDKeys: () => ({ publicKey: 'TEST_PUBLIC_KEY', privateKey: 'TEST_PRIVATE_KEY' }),
      setVapidDetails: () => {},
      sendNotification: async (_sub, payload) => {
        sent.push(JSON.parse(payload));
      }
    },
    env: {},
    fetchImpl: async (_url, options) => {
      if (options.headers.Authorization === 'Bearer valid-owner') {
        return { ok: true, json: async () => ({ id: 'owner-1', app_metadata: { role: 'owner' } }) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    }
  });

  const server = createAppServer({ pushManager: mockPushManager });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const keyRes = await fetch(`${baseUrl}/api/push/public-key`);
    assert.equal(keyRes.status, 200);
    const keyJson = await keyRes.json();
    assert.equal(keyJson.publicKey, 'TEST_PUBLIC_KEY');

    const badSubRes = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: { endpoint: 'http://insecure.example' }, orderIds: [] })
    });
    assert.equal(badSubRes.status, 400);

    const orderId = '22222222-2222-4222-8222-222222222222';
    const goodSubRes = await fetch(`${baseUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc12345',
          keys: {
            p256dh: 'BOr9x7v5k6s2t1u4w8y0z3a6c9e2g5i8k1m4o7q0s3u6w9y2',
            auth: 'a1b2c3d4e5f6g7h8i9j0'
          }
        },
        orderIds: [orderId]
      })
    });
    assert.equal(goodSubRes.status, 200);

    const unauthPushRes = await fetch(`${baseUrl}/api/push/order-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, status: 'confirmed' })
    });
    assert.equal(unauthPushRes.status, 401);

    const authPushRes = await fetch(`${baseUrl}/api/push/order-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-owner'
      },
      body: JSON.stringify({ orderId, status: 'confirmed', customerName: 'Jane' })
    });
    assert.equal(authPushRes.status, 200);
    const authPushJson = await authPushRes.json();
    assert.equal(authPushJson.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, 'confirmed');

    const statusRes = await fetch(`${baseUrl}/api/orders/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: [orderId] })
    });
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.statuses.length, 1);
    assert.equal(statusJson.statuses[0].status, 'confirmed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('records orders and serves phone-based order history with validation and status sync', async () => {
  const { createPushManager } = require('./push.js');
  const { createOrderHistoryManager } = require('./orders.js');

  const mockPushManager = createPushManager({
    webPushClient: {
      generateVAPIDKeys: () => ({ publicKey: 'TEST_PUBLIC_KEY', privateKey: 'TEST_PRIVATE_KEY' }),
      setVapidDetails: () => {},
      sendNotification: async () => {}
    },
    env: {},
    fetchImpl: async (_url, options) => {
      if (options.headers.Authorization === 'Bearer valid-owner') {
        return { ok: true, json: async () => ({ id: 'owner-1', app_metadata: { role: 'owner' } }) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    }
  });

  const orderHistoryManager = createOrderHistoryManager({
    pushManager: mockPushManager,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ([
        {
          id: '33333333-3333-4333-8333-333333333333',
          status: 'completed',
          total: 2500,
          created_at: '2026-01-02T11:00:00.000Z',
          items: [{ product_name: 'Pink Rose Hamper', quantity: 1, unit_price: 2500 }]
        }
      ])
    })
  });

  const server = createAppServer({ pushManager: mockPushManager, orderHistoryManager });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const badHistoryRes = await fetch(`${baseUrl}/api/orders/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '123' })
    });
    assert.equal(badHistoryRes.status, 400);

    const sessionOrderId = '44444444-4444-4444-8444-444444444444';
    const recordRes = await fetch(`${baseUrl}/api/orders/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: sessionOrderId,
        phone: '0722100530',
        items: [{ product_name: 'Personalized Coffee Mug', quantity: 2, unit_price: 1350 }],
        total: 2700,
        createdAt: '2026-01-03T12:00:00.000Z'
      })
    });
    assert.equal(recordRes.status, 200);

    const updateStatusRes = await fetch(`${baseUrl}/api/push/order-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-owner'
      },
      body: JSON.stringify({ orderId: sessionOrderId, status: 'confirmed' })
    });
    assert.equal(updateStatusRes.status, 200);

    const historyRes = await fetch(`${baseUrl}/api/orders/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+254722100530' })
    });
    assert.equal(historyRes.status, 200);
    const historyJson = await historyRes.json();
    assert.equal(historyJson.ok, true);
    assert.equal(historyJson.orders.length, 2);
    assert.equal(historyJson.orders[0].id, sessionOrderId);
    assert.equal(historyJson.orders[0].status, 'confirmed');
    assert.equal(historyJson.orders[1].id, '33333333-3333-4333-8333-333333333333');
    assert.equal(historyJson.orders[1].status, 'completed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
