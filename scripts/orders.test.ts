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
