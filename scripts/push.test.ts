import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isValidPushSubscription,
  buildOrderNotificationPayload,
  normalizeVapidSubject,
  createPushManager
} = require('./push.js');

const validSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/example-token-12345',
  keys: {
    p256dh: 'BOr9x7v5k6s2t1u4w8y0z3a6c9e2g5i8k1m4o7q0s3u6w9y2',
    auth: 'a1b2c3d4e5f6g7h8i9j0'
  }
};

const orderUuid = '11111111-1111-4111-8111-111111111111';

test('isValidPushSubscription validates endpoint protocol and keys', () => {
  assert.equal(isValidPushSubscription(validSubscription), true);
  assert.equal(isValidPushSubscription({ ...validSubscription, endpoint: 'http://evil.example/push' }), false);
  assert.equal(isValidPushSubscription({ ...validSubscription, endpoint: 'javascript:alert(1)' }), false);
  assert.equal(isValidPushSubscription({ endpoint: validSubscription.endpoint, keys: { p256dh: 'short', auth: 'short' } }), false);
  assert.equal(isValidPushSubscription(null), false);
});

test('buildOrderNotificationPayload builds clear status messages', () => {
  const confirmed = buildOrderNotificationPayload({
    orderId: orderUuid,
    status: 'confirmed',
    customerName: 'Amina Wanjiku'
  });
  assert.equal(confirmed.title, 'Zawadi Gift Shop · Order confirmed!');
  assert.match(confirmed.body, /Amina: Good news! Order 11111111 is confirmed/);
  assert.equal(confirmed.url, './#orders');

  const completed = buildOrderNotificationPayload({
    orderId: orderUuid,
    status: 'completed'
  });
  assert.equal(completed.title, 'Zawadi Gift Shop · Order delivered');
  assert.match(completed.body, /Order 11111111 has been marked as completed/);
});

test('createPushManager notifies matching order subscribers and prunes expired 410 endpoints', async () => {
  const sentPayloads = [];
  let shouldReturnGone = false;

  const mockWebPush = {
    generateVAPIDKeys: () => ({ publicKey: 'PUB_KEY', privateKey: 'PRIV_KEY' }),
    setVapidDetails: () => {},
    sendNotification: async (sub, payload) => {
      if (shouldReturnGone) {
        const err = new Error('Gone');
        err.statusCode = 410;
        throw err;
      }
      sentPayloads.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    }
  };

  const manager = createPushManager({ webPushClient: mockWebPush, env: {} });
  assert.equal(manager.getPublicKey().publicKey, 'PUB_KEY');

  const subRes = manager.subscribe({ subscription: validSubscription, orderIds: [orderUuid] });
  assert.equal(subRes.ok, true);
  assert.equal(subRes.subscribedOrderCount, 1);

  const notifyRes = await manager.notifyOrderStatus({
    orderId: orderUuid,
    status: 'confirmed',
    customerName: 'John'
  });
  assert.equal(notifyRes.sent, 1);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].payload.status, 'confirmed');

  shouldReturnGone = true;
  const prunedRes = await manager.notifyOrderStatus({ orderId: orderUuid, status: 'completed' });
  assert.equal(prunedRes.pruned, 1);
  assert.equal(manager.getSubscriptionCount(), 0);
});

test('verifyOwnerToken enforces owner app_metadata role', async () => {
  const mockWebPush = {
    generateVAPIDKeys: () => ({ publicKey: 'PUB_KEY', privateKey: 'PRIV_KEY' }),
    setVapidDetails: () => {},
    sendNotification: async () => {}
  };

  const manager = createPushManager({
    webPushClient: mockWebPush,
    env: {},
    fetchImpl: async (_url, options) => {
      if (options.headers.Authorization === 'Bearer owner-jwt') {
        return {
          ok: true,
          json: async () => ({ id: 'u1', app_metadata: { role: 'owner' } })
        };
      }
      if (options.headers.Authorization === 'Bearer customer-jwt') {
        return {
          ok: true,
          json: async () => ({ id: 'u2', app_metadata: { role: 'customer' } })
        };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    }
  });

  const missing = await manager.verifyOwnerToken('');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 401);

  const customer = await manager.verifyOwnerToken('Bearer customer-jwt');
  assert.equal(customer.ok, false);
  assert.equal(customer.status, 403);

  const owner = await manager.verifyOwnerToken('Bearer owner-jwt');
  assert.equal(owner.ok, true);
});

test('normalizeVapidSubject and createPushManager recover safely from invalid VAPID_SUBJECT or keys', () => {
  assert.equal(normalizeVapidSubject('7002'), 'mailto:orders@zawadigiftshop.example');
  assert.equal(normalizeVapidSubject('orders@zawadi.co.ke'), 'mailto:orders@zawadi.co.ke');
  assert.equal(normalizeVapidSubject('https://zawadi.example/contact'), 'https://zawadi.example/contact');

  const manager = createPushManager({
    env: {
      VAPID_SUBJECT: '7002',
      VAPID_PUBLIC_KEY: 'not-valid-base64===',
      VAPID_PRIVATE_KEY: 'bad'
    }
  });
  const keyInfo = manager.getPublicKey();
  assert.equal(typeof keyInfo.publicKey, 'string');
  assert.ok(keyInfo.publicKey.length > 20);
  assert.equal(keyInfo.configuredFromEnv, false);
});
