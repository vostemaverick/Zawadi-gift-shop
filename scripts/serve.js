const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createPushManager } = require('./push');
const { createOrderHistoryManager } = require('./orders');
const { createImageUploadManager } = require('./uploads');

const projectRoot = path.resolve(__dirname, '..');
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_UPLOAD_BODY_BYTES = 3 * 1024 * 1024;
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp']
]);

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function readJsonBody(request, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];
    let aborted = false;

    request.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (aborted) return;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('JSON body must be an object.'), { statusCode: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid JSON request body.'), { statusCode: 400 }));
      }
    });

    request.on('error', (error) => {
      if (!aborted) reject(Object.assign(error, { statusCode: 400 }));
    });
  });
}

function verifyPaymentWebhookSecret(request, env = process.env) {
  const configured = typeof env.PAYMENT_WEBHOOK_SECRET === 'string' ? env.PAYMENT_WEBHOOK_SECRET.trim() : '';
  if (!configured) return false;
  const provided = String(request.headers['x-payment-secret'] || '');
  const expectedBuf = Buffer.from(configured, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

async function handleApiRoute(request, response, pathname, pushManager, orderHistoryManager, imageUploadManager, checkHistoryRateLimit) {
  if (pathname === '/api/push/public-key') {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end();
      return true;
    }
    const info = pushManager.getPublicKey();
    sendJson(response, 200, { enabled: true, ...info });
    return true;
  }

  if (pathname === '/api/push/subscribe') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const result = pushManager.subscribe({
        subscription: body.subscription,
        orderIds: body.orderIds || []
      });
      if (!result.ok) {
        sendJson(response, result.status || 400, { error: result.error });
        return true;
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/push/unsubscribe') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const result = pushManager.unsubscribe({
        endpoint: body.endpoint,
        orderId: body.orderId
      });
      if (!result.ok) {
        sendJson(response, result.status || 400, { error: result.error });
        return true;
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/push/test') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const result = await pushManager.sendTestNotification({
        subscription: body.subscription
      });
      if (!result.ok) {
        sendJson(response, result.status || 400, { error: result.error });
        return true;
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/push/order-status') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    const authResult = await pushManager.verifyOwnerToken(request.headers.authorization || '');
    if (!authResult.ok) {
      sendJson(response, authResult.status || 401, { error: authResult.error });
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const result = await pushManager.notifyOrderStatus({
        orderId: body.orderId,
        status: body.status,
        customerName: body.customerName,
        expectedDelivery: body.expectedDelivery,
        customMessage: body.customMessage,
        paymentConfirmed: body.paymentConfirmed,
        paymentReference: body.paymentReference
      });
      if (!result.ok) {
        sendJson(response, result.status || 400, { error: result.error });
        return true;
      }
      orderHistoryManager.updateRecordedStatus(body.orderId, body.status, {
        expectedDelivery: body.expectedDelivery,
        ownerMessage: body.customMessage,
        paymentConfirmed: body.paymentConfirmed,
        paymentReference: body.paymentReference
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/orders/confirm') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    const authResult = await pushManager.verifyOwnerToken(request.headers.authorization || '');
    if (!authResult.ok) {
      sendJson(response, authResult.status || 401, { error: authResult.error });
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const result = await orderHistoryManager.confirmOrder({
        orderId: body.orderId,
        expectedDelivery: body.expectedDelivery,
        customMessage: body.customMessage,
        customerName: body.customerName,
        ownerToken: authResult.token || ''
      });
      if (!result.ok) {
        sendJson(response, result.status || 400, { error: result.error });
        return true;
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/orders/confirm-payment') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    const webhookAuthorized = verifyPaymentWebhookSecret(request);
    let ownerToken = '';
    if (!webhookAuthorized) {
      const authResult = await pushManager.verifyOwnerToken(request.headers.authorization || '');
      if (!authResult.ok) {
        sendJson(response, authResult.status || 401, { error: authResult.error });
        return true;
      }
      ownerToken = authResult.token || '';
    }
    try {
      const body = await readJsonBody(request);
      const result = await orderHistoryManager.confirmPayment({
        orderId: body.orderId,
        paymentReference: body.paymentReference,
        customerName: body.customerName,
        ownerToken
      });
      if (!result.ok) {
        sendJson(response, result.status || 400, { error: result.error });
        return true;
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/orders/status') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const statuses = await orderHistoryManager.lookupStatuses(body.orderIds || []);
      sendJson(response, 200, { statuses });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/orders/record') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const result = orderHistoryManager.recordOrder({
        orderId: body.orderId,
        phone: body.phone,
        items: body.items,
        total: body.total,
        status: body.status,
        createdAt: body.createdAt
      });
      if (!result.ok) {
        sendJson(response, result.status || 400, { error: result.error });
        return true;
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/orders/history') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    const clientIp = String(request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!checkHistoryRateLimit(clientIp)) {
      sendJson(response, 429, { error: 'Too many order lookup requests. Please wait a minute and try again.' });
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const result = await orderHistoryManager.lookupByPhone(body.phone);
      if (!result.ok) {
        sendJson(response, result.status || 400, { error: result.error });
        return true;
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === '/api/products/upload-image') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return true;
    }
    const authResult = await pushManager.verifyOwnerToken(request.headers.authorization || '');
    if (!authResult.ok) {
      sendJson(response, authResult.status || 401, { error: authResult.error });
      return true;
    }
    try {
      const body = await readJsonBody(request, MAX_UPLOAD_BODY_BYTES);
      const result = await imageUploadManager.saveImage({ dataUrl: body.dataUrl });
      if (!result.ok) {
        sendJson(response, result.status || 400, { error: result.error });
        return true;
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  return false;
}

function createAppServer({
  pushManager = createPushManager(),
  orderHistoryManager = createOrderHistoryManager({ pushManager }),
  imageUploadManager = createImageUploadManager()
} = {}) {
  const historyRateMap = new Map();
  const checkHistoryRateLimit = (ip) => {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const recent = (historyRateMap.get(ip) || []).filter((ts) => now - ts < windowMs);
    if (recent.length >= 30) {
      historyRateMap.set(ip, recent);
      return false;
    }
    recent.push(now);
    historyRateMap.set(ip, recent);
    return true;
  };

  return http.createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400);
      response.end('Invalid request path');
      return;
    }

    if (pathname.startsWith('/api/')) {
      const handled = await handleApiRoute(request, response, pathname, pushManager, orderHistoryManager, imageUploadManager, checkHistoryRateLimit);
      if (!handled) {
        sendJson(response, 404, { error: 'Not found' });
      }
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    const requestPath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const segments = requestPath.split('/').filter(Boolean);
    if (segments.some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const filePath = path.resolve(projectRoot, `.${requestPath}`);
    const relativePath = path.relative(projectRoot, filePath);
    if (relativePath.startsWith(`..${path.sep}`) || relativePath === '..' || path.isAbsolute(relativePath)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    fs.stat(filePath, (statError, stats) => {
      if (statError && !['ENOENT', 'ENOTDIR'].includes(statError.code)) {
        console.error(`Unable to inspect ${filePath}:`, statError);
        response.writeHead(500);
        response.end('Unable to inspect file');
        return;
      }

      if (statError || !stats.isFile()) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Length': stats.size,
        'Content-Type': mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff'
      });

      if (request.method === 'HEAD') {
        response.end();
        return;
      }

      const stream = fs.createReadStream(filePath);
      stream.on('error', (error) => {
        console.error(`Unable to serve ${filePath}:`, error);
        response.destroy(error);
      });
      stream.pipe(response);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const host = process.env.HOST || '0.0.0.0';
  const pushManager = createPushManager();
  const orderHistoryManager = createOrderHistoryManager({
    pushManager,
    stateFile: path.join(os.tmpdir(), 'zawadi-order-meta.json')
  });
  const server = createAppServer({ pushManager, orderHistoryManager });
  server.listen(port, host, () => {
    console.log(`Serving Zawadi Gift Shop at http://${host}:${port}`);
  });

  server.on('error', (error) => {
    console.error('Unable to start the storefront server:', error);
    process.exitCode = 1;
  });
}

module.exports = { createAppServer, verifyPaymentWebhookSecret };
