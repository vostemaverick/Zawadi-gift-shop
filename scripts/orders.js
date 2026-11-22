const fs = require('node:fs');
const path = require('node:path');
const { isValidUuid, sanitizeTextField } = require('./push');

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
      items: sanitizeOrderItems(order.items).length ? sanitizeOrderItems(order.items) : (existing?.items || []),
      expected_delivery: order.expected_delivery || existing?.expected_delivery || null,
      owner_message: order.owner_message || existing?.owner_message || null,
      payment_status: order.payment_status || existing?.payment_status || 'pending',
      payment_reference: order.payment_reference || existing?.payment_reference || null,
      payment_confirmed_at: order.payment_confirmed_at || existing?.payment_confirmed_at || null
    });
  }

  return Array.from(byId.values())
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 25);
}

function createOrderHistoryManager({
  env = process.env,
  fetchImpl = globalThis.fetch,
  pushManager = null,
  stateFile = ''
} = {}) {
  const recordedOrders = new Map();
  const orderMetadata = new Map();
  const supabaseUrl = (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  const supabaseAnonKey = env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
  const supabaseServiceKey = typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string'
    ? env.SUPABASE_SERVICE_ROLE_KEY.trim()
    : '';

  if (stateFile) {
    try {
      if (fs.existsSync(stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed)) {
            if (isValidUuid(key) && value && typeof value === 'object') {
              orderMetadata.set(key.toLowerCase(), value);
            }
          }
        }
      }
    } catch {
      // Ignore corrupt cache on startup
    }
  }

  function persistMetadata() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const payload = JSON.stringify(Object.fromEntries(orderMetadata.entries()));
      fs.writeFileSync(stateFile, payload, 'utf8');
    } catch {
      // Non-fatal persistence failure
    }
  }

  function getOrderMeta(orderId) {
    if (!isValidUuid(orderId)) return null;
    return orderMetadata.get(orderId.trim().toLowerCase()) || null;
  }

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

  function updateRecordedStatus(orderId, status, details = {}) {
    if (!isValidUuid(orderId) || !VALID_STATUSES.has(status)) return;
    const normalizedId = orderId.trim().toLowerCase();
    const entry = recordedOrders.get(normalizedId);
    if (entry) {
      entry.status = status;
    }

    const prev = orderMetadata.get(normalizedId) || {};
    const expectedDelivery = sanitizeTextField(details.expectedDelivery, 120) || prev.expectedDelivery || null;
    const ownerMessage = sanitizeTextField(details.ownerMessage || details.customMessage, 280) || prev.ownerMessage || null;
    const paymentConfirmed = Boolean(details.paymentConfirmed) || prev.paymentStatus === 'paid';
    const paymentReference = sanitizeTextField(details.paymentReference, 80) || prev.paymentReference || null;
    const confirmedAt = status === 'confirmed' ? (prev.confirmedAt || new Date().toISOString()) : (prev.confirmedAt || null);
    const paymentConfirmedAt = paymentConfirmed
      ? (prev.paymentConfirmedAt || new Date().toISOString())
      : null;

    orderMetadata.set(normalizedId, {
      id: normalizedId,
      status,
      expectedDelivery,
      ownerMessage,
      paymentStatus: paymentConfirmed ? 'paid' : 'pending',
      paymentReference,
      confirmedAt,
      paymentConfirmedAt,
      updatedAt: new Date().toISOString()
    });
    persistMetadata();
  }

  async function syncSupabaseOrderStatus(orderId, status, ownerToken = '') {
    if (typeof fetchImpl !== 'function') return { ok: false, skipped: true };
    const authToken = ownerToken || supabaseServiceKey;
    if (!authToken) return { ok: false, skipped: true };
    const apiKey = supabaseServiceKey && authToken === supabaseServiceKey ? supabaseServiceKey : supabaseAnonKey;

    try {
      const response = await fetchImpl(`${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: apiKey,
          Authorization: `Bearer ${authToken}`,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ status })
      });
      return { ok: response.ok, statusCode: response.status };
    } catch {
      return { ok: false, error: 'Database sync request failed.' };
    }
  }

  async function confirmOrder({
    orderId,
    expectedDelivery = '',
    customMessage = '',
    customerName = '',
    ownerToken = ''
  }) {
    if (!isValidUuid(orderId)) {
      return { ok: false, status: 400, error: 'A valid orderId UUID is required.' };
    }
    const eta = sanitizeTextField(expectedDelivery, 120);
    if (!eta) {
      return { ok: false, status: 400, error: 'Please enter when the customer should expect their order.' };
    }
    const note = sanitizeTextField(customMessage, 280);
    const normalizedId = orderId.trim().toLowerCase();

    const dbSync = await syncSupabaseOrderStatus(normalizedId, 'confirmed', ownerToken);
    if (ownerToken && !dbSync.skipped && !dbSync.ok) {
      return { ok: false, status: 502, error: 'Could not save confirmed order status to the database.' };
    }

    updateRecordedStatus(normalizedId, 'confirmed', {
      expectedDelivery: eta,
      ownerMessage: note
    });

    let pushResult = null;
    if (pushManager?.notifyOrderStatus) {
      pushResult = await pushManager.notifyOrderStatus({
        orderId: normalizedId,
        status: 'confirmed',
        customerName,
        expectedDelivery: eta,
        customMessage: note
      });
      if (!pushResult.ok) {
        return pushResult;
      }
    }

    const meta = getOrderMeta(normalizedId);
    return {
      ok: true,
      orderId: normalizedId,
      status: 'confirmed',
      expectedDelivery: eta,
      ownerMessage: note || null,
      confirmedAt: meta?.confirmedAt || new Date().toISOString(),
      customerMessage: pushResult?.customerMessage || '',
      pushResult
    };
  }

  async function confirmPayment({
    orderId,
    paymentReference = '',
    customerName = '',
    ownerToken = ''
  }) {
    if (!isValidUuid(orderId)) {
      return { ok: false, status: 400, error: 'A valid orderId UUID is required.' };
    }
    const normalizedId = orderId.trim().toLowerCase();
    const payRef = sanitizeTextField(paymentReference, 80);

    const dbSync = await syncSupabaseOrderStatus(normalizedId, 'completed', ownerToken);
    if (ownerToken && !dbSync.skipped && !dbSync.ok) {
      return { ok: false, status: 502, error: 'Could not auto-update order status to completed in the database.' };
    }

    updateRecordedStatus(normalizedId, 'completed', {
      paymentConfirmed: true,
      paymentReference: payRef
    });

    let pushResult = null;
    if (pushManager?.notifyOrderStatus) {
      pushResult = await pushManager.notifyOrderStatus({
        orderId: normalizedId,
        status: 'completed',
        customerName,
        paymentConfirmed: true,
        paymentReference: payRef
      });
      if (!pushResult.ok) {
        return pushResult;
      }
    }

    const meta = getOrderMeta(normalizedId);
    return {
      ok: true,
      orderId: normalizedId,
      status: 'completed',
      paymentStatus: 'paid',
      paymentReference: payRef || null,
      paymentConfirmedAt: meta?.paymentConfirmedAt || new Date().toISOString(),
      customerMessage: pushResult?.customerMessage || '',
      pushResult
    };
  }

  function applyMetadataToOrder(order) {
    if (!order || !isValidUuid(order.id)) return order;
    const key = String(order.id).toLowerCase();
    const meta = orderMetadata.get(key);
    const pushMeta = pushManager?.getOrderStatuses?.([key])?.[0];
    const effectiveStatus = pushMeta?.status || meta?.status || order.status || 'pending';
    return {
      ...order,
      status: VALID_STATUSES.has(order.status) && order.status === 'completed'
        ? 'completed'
        : effectiveStatus,
      expected_delivery: meta?.expectedDelivery || pushMeta?.expectedDelivery || order.expected_delivery || null,
      owner_message: meta?.ownerMessage || pushMeta?.ownerMessage || order.owner_message || null,
      payment_status: meta?.paymentStatus || pushMeta?.paymentStatus || order.payment_status || 'pending',
      payment_reference: meta?.paymentReference || pushMeta?.paymentReference || order.payment_reference || null,
      payment_confirmed_at: meta?.paymentConfirmedAt || order.payment_confirmed_at || null
    };
  }

  async function lookupByPhone(rawPhone) {
    const phoneKey = normalizePhoneLookup(rawPhone);
    if (!phoneKey) {
      return { ok: false, status: 400, error: 'Enter a valid phone number (at least 7 digits).' };
    }

    const localMatches = [];
    for (const entry of recordedOrders.values()) {
      if (entry.phoneKey !== phoneKey) continue;
      localMatches.push(applyMetadataToOrder({
        id: entry.id,
        status: entry.status,
        total: entry.total,
        created_at: entry.created_at,
        items: entry.items
      }));
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
            remoteOrders = data.map(applyMetadataToOrder);
            source = 'database';
            databaseConfigured = true;
          }
        }
      } catch {
        // Fall back to local/session order records if database lookup fails or offline
      }
    }

    const orders = mergeOrderHistoryLists(remoteOrders, localMatches).map(applyMetadataToOrder);
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
      const meta = orderMetadata.get(id);
      if (recorded || meta) {
        byId.set(id, {
          id,
          status: meta?.status || recorded?.status || 'pending',
          expectedDelivery: meta?.expectedDelivery || null,
          ownerMessage: meta?.ownerMessage || null,
          paymentStatus: meta?.paymentStatus || 'pending',
          paymentReference: meta?.paymentReference || null,
          paymentConfirmedAt: meta?.paymentConfirmedAt || null,
          updatedAt: meta?.updatedAt || recorded?.created_at || new Date().toISOString()
        });
      }
    }

    if (pushManager?.getOrderStatuses) {
      for (const row of pushManager.getOrderStatuses(validIds)) {
        if (!row?.id) continue;
        const key = String(row.id).toLowerCase();
        const prev = byId.get(key) || {};
        byId.set(key, {
          ...prev,
          ...row,
          expectedDelivery: row.expectedDelivery || prev.expectedDelivery || null,
          ownerMessage: row.ownerMessage || prev.ownerMessage || null,
          paymentStatus: row.paymentStatus === 'paid' || prev.paymentStatus === 'paid' ? 'paid' : 'pending',
          paymentReference: row.paymentReference || prev.paymentReference || null
        });
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
                const key = String(row.id).toLowerCase();
                const prev = byId.get(key) || {};
                const meta = orderMetadata.get(key);
                byId.set(key, {
                  id: key,
                  status: meta?.paymentStatus === 'paid' ? 'completed' : row.status,
                  expectedDelivery: meta?.expectedDelivery || prev.expectedDelivery || null,
                  ownerMessage: meta?.ownerMessage || prev.ownerMessage || null,
                  paymentStatus: meta?.paymentStatus || prev.paymentStatus || 'pending',
                  paymentReference: meta?.paymentReference || prev.paymentReference || null,
                  paymentConfirmedAt: meta?.paymentConfirmedAt || prev.paymentConfirmedAt || null,
                  updatedAt: meta?.updatedAt || row.created_at || new Date().toISOString()
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
    confirmOrder,
    confirmPayment,
    getOrderMeta,
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
