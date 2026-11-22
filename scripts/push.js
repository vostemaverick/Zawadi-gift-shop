const webpush = require('web-push');

const DEFAULT_SUPABASE_URL = 'https://rldomswxlgcahqwqfjrh.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsZG9tc3d4bGdjYWhxd3FmanJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzNDMzOTIsImV4cCI6MjEwOTkxOTM5Mn0.6WR4MIULJ4VleOVSJ_zq_4vUXeWmQzFc8gUDS3YOHj4';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ORDER_STATUS_META = {
  pending: {
    label: 'Pending confirmation',
    title: 'Order received',
    body: (ref) => `Order ${ref} has been received and is awaiting confirmation.`
  },
  confirmed: {
    label: 'Confirmed & preparing',
    title: 'Order confirmed!',
    body: (ref) => `Good news! Order ${ref} is confirmed and being prepared for delivery.`
  },
  completed: {
    label: 'Delivered / completed',
    title: 'Order delivered',
    body: (ref) => `Order ${ref} has been marked as completed. Thank you for gifting with Zawadi!`
  },
  cancelled: {
    label: 'Cancelled',
    title: 'Order update',
    body: (ref) => `Order ${ref} was cancelled. Contact Zawadi Gift Shop on 0722100530 if you need help.`
  }
};

function isValidUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

function isValidPushSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') return false;
  if (typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 2000) return false;
  let parsedUrl;
  try {
    parsedUrl = new URL(subscription.endpoint);
  } catch {
    return false;
  }
  const isLocalHttp = parsedUrl.protocol === 'http:' && (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1');
  if (parsedUrl.protocol !== 'https:' && !isLocalHttp) return false;

  if (!subscription.keys || typeof subscription.keys !== 'object') return false;
  const { p256dh, auth } = subscription.keys;
  if (typeof p256dh !== 'string' || p256dh.trim().length < 16 || p256dh.length > 512) return false;
  if (typeof auth !== 'string' || auth.trim().length < 8 || auth.length > 256) return false;
  return true;
}

function formatOrderReference(orderId) {
  return String(orderId || '').slice(0, 8).toUpperCase() || 'ORDER';
}

function buildOrderNotificationPayload({ orderId, status, orderReference, customerName }) {
  const normalizedStatus = Object.prototype.hasOwnProperty.call(ORDER_STATUS_META, status)
    ? status
    : 'pending';
  const ref = orderReference || formatOrderReference(orderId);
  const meta = ORDER_STATUS_META[normalizedStatus];
  const greeting = customerName ? `${String(customerName).trim().split(/\s+/)[0]}: ` : '';

  return {
    title: `Zawadi Gift Shop · ${meta.title}`,
    body: `${greeting}${meta.body(ref)}`,
    tag: `zawadi-order-${orderId || ref}`,
    orderId: orderId || null,
    orderReference: ref,
    status: normalizedStatus,
    url: './#orders'
  };
}

const DEFAULT_VAPID_SUBJECT = 'mailto:orders@zawadigiftshop.example';

function normalizeVapidSubject(rawSubject) {
  if (typeof rawSubject !== 'string') return DEFAULT_VAPID_SUBJECT;
  const trimmed = rawSubject.trim();
  if (!trimmed) return DEFAULT_VAPID_SUBJECT;

  const candidate = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
    ? `mailto:${trimmed}`
    : trimmed;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      return candidate;
    }
  } catch {
    // Fall back to default mailto subject below
  }

  console.warn(`[push] Ignoring invalid VAPID_SUBJECT "${trimmed}"; using default mailto subject.`);
  return DEFAULT_VAPID_SUBJECT;
}

function createPushManager({
  webPushClient = webpush,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  let vapidPublicKey = typeof env.VAPID_PUBLIC_KEY === 'string' ? env.VAPID_PUBLIC_KEY.trim() : '';
  let vapidPrivateKey = typeof env.VAPID_PRIVATE_KEY === 'string' ? env.VAPID_PRIVATE_KEY.trim() : '';
  const vapidSubject = normalizeVapidSubject(env.VAPID_SUBJECT);
  let configuredFromEnv = Boolean(vapidPublicKey && vapidPrivateKey);

  if (!configuredFromEnv) {
    const generated = webPushClient.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
  }

  try {
    webPushClient.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch (error) {
    console.warn('[push] Invalid VAPID configuration; falling back to ephemeral runtime keys:', error?.message || error);
    const generated = webPushClient.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
    configuredFromEnv = false;
    webPushClient.setVapidDetails(DEFAULT_VAPID_SUBJECT, vapidPublicKey, vapidPrivateKey);
  }

  const subscriptions = new Map();
  const orderStatuses = new Map();
  const supabaseUrl = (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  const supabaseAnonKey = env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

  function getPublicKey() {
    return {
      publicKey: vapidPublicKey,
      configuredFromEnv
    };
  }

  function subscribe({ subscription, orderIds = [] }) {
    if (!isValidPushSubscription(subscription)) {
      return { ok: false, status: 400, error: 'A valid Web Push subscription with endpoint and encryption keys is required.' };
    }
    if (!Array.isArray(orderIds) || orderIds.length > 50) {
      return { ok: false, status: 400, error: 'orderIds must be an array of up to 50 order IDs.' };
    }

    const validOrderIds = orderIds
      .map((id) => String(id || '').trim().toLowerCase())
      .filter((id) => isValidUuid(id));

    const existing = subscriptions.get(subscription.endpoint);
    const mergedOrderIds = existing ? new Set(existing.orderIds) : new Set();
    for (const orderId of validOrderIds) {
      mergedOrderIds.add(orderId);
    }

    subscriptions.set(subscription.endpoint, {
      subscription: {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime ?? null,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth
        }
      },
      orderIds: mergedOrderIds,
      updatedAt: Date.now()
    });

    return {
      ok: true,
      subscribedOrderCount: mergedOrderIds.size,
      totalSubscribers: subscriptions.size
    };
  }

  function unsubscribe({ endpoint, orderId }) {
    if (typeof endpoint !== 'string' || !endpoint) {
      return { ok: false, status: 400, error: 'Subscription endpoint is required.' };
    }
    const entry = subscriptions.get(endpoint);
    if (!entry) {
      return { ok: true, removed: false };
    }
    if (orderId && isValidUuid(orderId)) {
      entry.orderIds.delete(orderId.trim().toLowerCase());
      if (entry.orderIds.size === 0) {
        subscriptions.delete(endpoint);
      }
      return { ok: true, removed: true };
    }
    subscriptions.delete(endpoint);
    return { ok: true, removed: true };
  }

  async function sendTestNotification({ subscription }) {
    if (!isValidPushSubscription(subscription)) {
      return { ok: false, status: 400, error: 'A valid push subscription is required for a test notification.' };
    }

    const payload = JSON.stringify({
      title: 'Zawadi Gift Shop · Alerts enabled',
      body: 'You will receive live order status updates directly on this device.',
      tag: 'zawadi-test-alert',
      status: 'confirmed',
      url: './#orders'
    });

    try {
      await webPushClient.sendNotification(subscription, payload);
      return { ok: true, delivered: true };
    } catch (error) {
      if (error && (error.statusCode === 404 || error.statusCode === 410)) {
        subscriptions.delete(subscription.endpoint);
        return { ok: false, status: 410, error: 'Push subscription expired. Re-enable notifications to create a fresh subscription.' };
      }
      return { ok: false, status: 502, error: 'Push service rejected the test notification.' };
    }
  }

  async function verifyOwnerToken(authHeader) {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      return { ok: false, status: 401, error: 'Missing owner authorization token.' };
    }
    const token = authHeader.slice(7).trim();
    if (!token || token.length > 4096) {
      return { ok: false, status: 401, error: 'Invalid authorization token.' };
    }
    if (typeof fetchImpl !== 'function') {
      return { ok: false, status: 500, error: 'Fetch is unavailable for token verification.' };
    }

    try {
      const response = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${token}`
        }
      });
      if (!response.ok) {
        return { ok: false, status: 401, error: 'Owner session is invalid or expired.' };
      }
      const user = await response.json();
      if (user?.app_metadata?.role !== 'owner') {
        return { ok: false, status: 403, error: 'Owner role is required to send order status push notifications.' };
      }
      return { ok: true, user };
    } catch {
      return { ok: false, status: 502, error: 'Unable to verify owner credentials.' };
    }
  }

  async function notifyOrderStatus({ orderId, status, customerName }) {
    if (!isValidUuid(orderId)) {
      return { ok: false, status: 400, error: 'A valid orderId UUID is required.' };
    }
    if (!Object.prototype.hasOwnProperty.call(ORDER_STATUS_META, status)) {
      return { ok: false, status: 400, error: 'Status must be pending, confirmed, completed, or cancelled.' };
    }

    const normalizedOrderId = orderId.trim().toLowerCase();
    orderStatuses.set(normalizedOrderId, {
      id: normalizedOrderId,
      status,
      updatedAt: new Date().toISOString()
    });
    const payload = JSON.stringify(
      buildOrderNotificationPayload({
        orderId: normalizedOrderId,
        status,
        orderReference: formatOrderReference(normalizedOrderId),
        customerName
      })
    );

    const targets = [];
    for (const entry of subscriptions.values()) {
      if (entry.orderIds.has(normalizedOrderId)) {
        targets.push(entry);
      }
    }

    let sent = 0;
    let failed = 0;
    let pruned = 0;

    await Promise.all(
      targets.map(async (entry) => {
        try {
          await webPushClient.sendNotification(entry.subscription, payload);
          sent += 1;
        } catch (error) {
          failed += 1;
          if (error && (error.statusCode === 404 || error.statusCode === 410)) {
            subscriptions.delete(entry.subscription.endpoint);
            pruned += 1;
          }
        }
      })
    );

    return {
      ok: true,
      orderId: normalizedOrderId,
      status,
      matchedSubscribers: targets.length,
      sent,
      failed,
      pruned
    };
  }

  function getOrderStatuses(orderIds = []) {
    if (!Array.isArray(orderIds)) return [];
    const results = [];
    for (const rawId of orderIds.slice(0, 50)) {
      if (!isValidUuid(rawId)) continue;
      const entry = orderStatuses.get(rawId.trim().toLowerCase());
      if (entry) results.push(entry);
    }
    return results;
  }

  return {
    getPublicKey,
    subscribe,
    unsubscribe,
    sendTestNotification,
    verifyOwnerToken,
    notifyOrderStatus,
    getOrderStatuses,
    getSubscriptionCount: () => subscriptions.size
  };
}

module.exports = {
  ORDER_STATUS_META,
  isValidUuid,
  isValidPushSubscription,
  formatOrderReference,
  buildOrderNotificationPayload,
  normalizeVapidSubject,
  createPushManager
};
