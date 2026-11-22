const { isValidUuid } = require('./push');

const DEFAULT_SUPABASE_URL = 'https://rldomswxlgcahqwqfjrh.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsZG9tc3d4bGdjYWhxd3FmanJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzNDMzOTIsImV4cCI6MjEwOTkxOTM5Mn0.6WR4MIULJ4VleOVSJ_zq_4vUXeWmQzFc8gUDS3YOHj4';

const VALID_STATUSES = new Set(['pending', 'confirmed', 'completed', 'cancelled']);

function normalizePhoneLookup(rawPhone) {
  if (typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 20) return null;

  if (digits.length === 10 && /^0[17]\d{8}$/.test(digits)) {
    return `ke:${digits.slice(1)}`;
  }
  if (digits.length === 12 && /^254[17]\d{8}$/.test(digits)) {
    return `ke:${digits.slice(3)}`;
  }
  if (digits.length === 9 && /^[17]\d{8}$/.test(digits)) {
    return `ke:${digits}`;
  }
  return `raw:${digits}`;
}

function sanitizeOrderItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const productName = typeof item.product_name === 'string'
      ? item.product_name.trim().slice(0, 120)
      : typeof item.name === 'string'
        ? item.name.trim().slice(0, 120)
        : '';
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unit_price ?? item.price);
    if (!productName || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      return [];
    }
    return [{
      product_name: productName,
      quantity: Math.floor(quantity),
      unit_price: Math.round(unitPrice)
    }];
  });
}

function mergeOrderHistoryLists(remoteOrders = [], localOrders = []) {
  const byId = new Map();

  for (const order of localOrders) {
    if (!order || !isValidUuid(order.id)) continue;
    byId.set(String(order.id).toLowerCase(), order);
  }

  for (const order of remoteOrders) {
    if (!order || !isValidUuid(order.id)) continue;
    const key = String(order.id).toLowerCase();
    const existing = byId.get(key);
    byId.set(key, {
      id: key,
      status: VALID_STATUSES.has(order.status) ? order.status : (existing?.status || 'pending'),
      total: Number.isFinite(Number(order.total)) ? Number(order.total) : (existing?.total || 0),
      created_at: order.created_at || existing?.created_at || new Date().toISOString(),
      items: sanitizeOrderItems(order.items).length ? sanitizeOrderItems(order.items) : (existing?.items || [])
    });
  }

  return Array.from(byId.values())
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 25);
}

function createOrderHistoryManager({
  env = process.env,
  fetchImpl = globalThis.fetch,
  pushManager = null
} = {}) {
  const recordedOrders = new Map();
  const supabaseUrl = (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  const supabaseAnonKey = env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

  function recordOrder({ orderId, phone, items, total, status = 'pending', createdAt }) {
    if (!isValidUuid(orderId)) {
      return { ok: false, status: 400, error: 'A valid orderId UUID is required.' };
    }
    const phoneKey = normalizePhoneLookup(phone);
    if (!phoneKey) {
      return { ok: false, status: 400, error: 'A valid phone number is required.' };
    }

    const normalizedId = orderId.trim().toLowerCase();
    const sanitizedItems = sanitizeOrderItems(items);
    const numericTotal = Number(total);
    if (!Number.isFinite(numericTotal) || numericTotal <= 0) {
      return { ok: false, status: 400, error: 'A valid positive order total is required.' };
    }

    recordedOrders.set(normalizedId, {
      id: normalizedId,
      phoneKey,
      status: VALID_STATUSES.has(status) ? status : 'pending',
      total: Math.round(numericTotal),
      created_at: typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt))
        ? createdAt
        : new Date().toISOString(),
      items: sanitizedItems
    });

    return { ok: true, id: normalizedId };
  }

  function updateRecordedStatus(orderId, status) {
    if (!isValidUuid(orderId) || !VALID_STATUSES.has(status)) return;
    const entry = recordedOrders.get(orderId.trim().toLowerCase());
    if (entry) {
      entry.status = status;
    }
  }

  async function lookupByPhone(rawPhone) {
    const phoneKey = normalizePhoneLookup(rawPhone);
    if (!phoneKey) {
      return { ok: false, status: 400, error: 'Enter a valid phone number (at least 7 digits).' };
    }

    const localMatches = [];
    for (const entry of recordedOrders.values()) {
      if (entry.phoneKey !== phoneKey) continue;
      const liveStatus = pushManager?.getOrderStatuses?.([entry.id])?.[0]?.status;
      localMatches.push({
        id: entry.id,
        status: liveStatus || entry.status,
        total: entry.total,
        created_at: entry.created_at,
        items: entry.items
      });
    }

    let remoteOrders = [];
    let source = 'session';
    let databaseConfigured = false;

    if (typeof fetchImpl === 'function') {
      try {
        const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/get_order_history_by_phone`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${supabaseAnonKey}`
          },
          body: JSON.stringify({ p_phone: rawPhone.trim() })
        });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data)) {
            remoteOrders = data;
            source = 'database';
            databaseConfigured = true;
          }
        }
      } catch {
        // Fall back to local/session order records if database lookup fails or offline
      }
    }

    const orders = mergeOrderHistoryLists(remoteOrders, localMatches);
    return {
      ok: true,
      orders,
      source,
      databaseConfigured
    };
  }

  async function lookupStatuses(orderIds = []) {
    if (!Array.isArray(orderIds) || !orderIds.length) return [];
    const validIds = orderIds
      .slice(0, 50)
      .map((id) => String(id || '').trim().toLowerCase())
      .filter((id) => isValidUuid(id));
    if (!validIds.length) return [];

    const byId = new Map();
    for (const id of validIds) {
      const recorded = recordedOrders.get(id);
      if (recorded) {
        byId.set(id, { id, status: recorded.status, updatedAt: recorded.created_at });
      }
    }

    if (pushManager?.getOrderStatuses) {
      for (const row of pushManager.getOrderStatuses(validIds)) {
        if (row?.id) byId.set(String(row.id).toLowerCase(), row);
      }
    }

    if (typeof fetchImpl === 'function') {
      try {
        const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/get_order_status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${supabaseAnonKey}`
          },
          body: JSON.stringify({ p_order_ids: validIds })
        });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data)) {
            for (const row of data) {
              if (row && isValidUuid(row.id) && VALID_STATUSES.has(row.status)) {
                byId.set(String(row.id).toLowerCase(), {
                  id: String(row.id).toLowerCase(),
                  status: row.status,
                  updatedAt: row.created_at || new Date().toISOString()
                });
              }
            }
          }
        }
      } catch {
        // Ignore network/offline errors and return in-memory statuses
      }
    }

    return Array.from(byId.values());
  }

  return {
    recordOrder,
    updateRecordedStatus,
    lookupByPhone,
    lookupStatuses
  };
}

module.exports = {
  normalizePhoneLookup,
  sanitizeOrderItems,
  mergeOrderHistoryLists,
  createOrderHistoryManager
};
