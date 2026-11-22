import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizePhoneLookup,
  sanitizeOrderItems,
  mergeOrderHistoryLists,
  createOrderHistoryManager
} = require('./orders.js');

test('normalizePhoneLookup matches equivalent Kenyan phone formats and rejects invalid input', () => {
  assert.equal(normalizePhoneLookup('0722100530'), 'ke:722100530');
  assert.equal(normalizePhoneLookup('+254 722 100 530'), 'ke:722100530');
  assert.equal(normalizePhoneLookup('254722100530'), 'ke:722100530');
  assert.equal(normalizePhoneLookup('722100530'), 'ke:722100530');
  assert.equal(normalizePhoneLookup('0112345678'), 'ke:112345678');
  assert.equal(normalizePhoneLookup('12345'), null);
  assert.equal(normalizePhoneLookup(''), null);
  assert.equal(normalizePhoneLookup(null), null);
});

test('sanitizeOrderItems filters invalid entries and normalizes fields', () => {
  const items = sanitizeOrderItems([
    { name: 'Pink Rose Hamper', quantity: 2, price: 2500 },
    { product_name: 'Custom Mug', quantity: 1, unit_price: 1350 },
    { product_name: '', quantity: 1, unit_price: 500 },
    { product_name: 'Bad Qty', quantity: 0, unit_price: 500 }
  ]);
  assert.deepEqual(items, [
    { product_name: 'Pink Rose Hamper', quantity: 2, unit_price: 2500 },
    { product_name: 'Custom Mug', quantity: 1, unit_price: 1350 }
  ]);
});

test('mergeOrderHistoryLists deduplicates by id, prefers remote status, and sorts newest first', () => {
  const merged = mergeOrderHistoryLists(
    [
      {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'confirmed',
        total: 2500,
        created_at: '2026-01-10T10:00:00.000Z',
        items: [{ product_name: 'Rose Bouquet', quantity: 1, unit_price: 2500 }]
      }
    ],
    [
      {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'pending',
        total: 2500,
        created_at: '2026-01-10T10:00:00.000Z',
        items: [{ product_name: 'Rose Bouquet', quantity: 1, unit_price: 2500 }]
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        status: 'pending',
        total: 1350,
        created_at: '2026-01-12T12:00:00.000Z',
        items: [{ product_name: 'Custom Mug', quantity: 1, unit_price: 1350 }]
      }
    ]
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, '22222222-2222-4222-8222-222222222222');
  assert.equal(merged[1].status, 'confirmed');
});

test('createOrderHistoryManager merges Supabase RPC results with session records and handles RPC 404 fallback', async () => {
  const manager = createOrderHistoryManager({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon-key' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ([
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'completed',
          total: 3200,
          created_at: '2026-01-01T08:00:00.000Z',
          items: [{ product_name: 'Luxury Gift Hamper', quantity: 1, unit_price: 3200 }]
        }
      ])
    })
  });

  const recResult = manager.recordOrder({
    orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    phone: '0722100530',
    items: [{ product_name: 'Greeting Card', quantity: 2, unit_price: 350 }],
    total: 700,
    createdAt: '2026-01-05T09:00:00.000Z'
  });
  assert.equal(recResult.ok, true);

  manager.updateRecordedStatus('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'confirmed');

  const historyResult = await manager.lookupByPhone('+254 722 100 530');
  assert.equal(historyResult.ok, true);
  assert.equal(historyResult.source, 'database');
  assert.equal(historyResult.orders.length, 2);
  assert.equal(historyResult.orders[0].id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(historyResult.orders[0].status, 'confirmed');
  assert.equal(historyResult.orders[1].id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

  const fallbackManager = createOrderHistoryManager({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ code: 'PGRST202' }) })
  });
  fallbackManager.recordOrder({
    orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    phone: '0711223344',
    items: [{ product_name: 'Gift Box', quantity: 1, unit_price: 1800 }],
    total: 1800
  });
  const fallbackLookup = await fallbackManager.lookupByPhone('254711223344');
  assert.equal(fallbackLookup.ok, true);
  assert.equal(fallbackLookup.source, 'session');
  assert.equal(fallbackLookup.orders.length, 1);
  assert.equal(fallbackLookup.orders[0].items[0].product_name, 'Gift Box');

  const statusList = await manager.lookupStatuses(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  assert.equal(statusList.length, 2);
});

test('confirmOrder saves expected delivery and confirmPayment auto-updates order to completed with persistence', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createPushManager } = require('./push.js');

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zawadi-orders-meta-'));
  const stateFile = path.join(tmpDir, 'order-meta.json');
  const supabasePatches = [];
  const sentNotifications = [];

  const mockPush = createPushManager({
    webPushClient: {
      generateVAPIDKeys: () => ({ publicKey: 'PUB_KEY', privateKey: 'PRIV_KEY' }),
      setVapidDetails: () => {},
      sendNotification: async (_sub, payload) => {
        sentNotifications.push(JSON.parse(payload));
      }
    },
    env: {}
  });

  const orderId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  mockPush.subscribe({
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/order-confirm-test',
      keys: {
        p256dh: 'BOr9x7v5k6s2t1u4w8y0z3a6c9e2g5i8k1m4o7q0s3u6w9y2',
        auth: 'a1b2c3d4e5f6g7h8i9j0'
      }
    },
    orderIds: [orderId]
  });

  const fetchMock = async (url, options = {}) => {
    if (String(url).includes('/rest/v1/orders') && options.method === 'PATCH') {
      supabasePatches.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true, status: 204 };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    const manager = createOrderHistoryManager({
      env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon-key' },
      fetchImpl: fetchMock,
      pushManager: mockPush,
      stateFile
    });

    manager.recordOrder({
      orderId,
      phone: '0722100530',
      items: [{ product_name: 'Pink Rose Hamper', quantity: 1, unit_price: 2500 }],
      total: 2500
    });

    const missingEta = await manager.confirmOrder({ orderId, expectedDelivery: '   ' });
    assert.equal(missingEta.ok, false);
    assert.equal(missingEta.status, 400);

    const confirmRes = await manager.confirmOrder({
      orderId,
      expectedDelivery: 'Today within 2 hours',
      customMessage: 'Rider Peter will call before arriving.',
      customerName: 'Grace Muthoni',
      ownerToken: 'owner-jwt'
    });
    assert.equal(confirmRes.ok, true);
    assert.equal(confirmRes.status, 'confirmed');
    assert.equal(confirmRes.expectedDelivery, 'Today within 2 hours');
    assert.match(confirmRes.customerMessage, /Expected delivery: Today within 2 hours/);
    assert.equal(sentNotifications.length, 1);
    assert.equal(supabasePatches[0].body.status, 'confirmed');

    const payRes = await manager.confirmPayment({
      orderId,
      paymentReference: 'MPESA-QWE123',
      customerName: 'Grace Muthoni',
      ownerToken: 'owner-jwt'
    });
    assert.equal(payRes.ok, true);
    assert.equal(payRes.status, 'completed');
    assert.equal(payRes.paymentStatus, 'paid');
    assert.equal(payRes.paymentReference, 'MPESA-QWE123');
    assert.equal(sentNotifications.length, 2);
    assert.equal(sentNotifications[1].status, 'completed');
    assert.equal(supabasePatches[1].body.status, 'completed');

    const history = await manager.lookupByPhone('0722100530');
    assert.equal(history.orders[0].status, 'completed');
    assert.equal(history.orders[0].expected_delivery, 'Today within 2 hours');
    assert.equal(history.orders[0].payment_status, 'paid');
    assert.equal(history.orders[0].payment_reference, 'MPESA-QWE123');

    const reloadedManager = createOrderHistoryManager({ stateFile, fetchImpl: fetchMock });
    const reloadedStatuses = await reloadedManager.lookupStatuses([orderId]);
    assert.equal(reloadedStatuses.length, 1);
    assert.equal(reloadedStatuses[0].status, 'completed');
    assert.equal(reloadedStatuses[0].expectedDelivery, 'Today within 2 hours');
    assert.equal(reloadedStatuses[0].paymentStatus, 'paid');
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});
