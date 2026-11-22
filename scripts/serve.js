const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
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

function createAppServer() {
  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    let filePath;
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const requestPath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      filePath = path.resolve(projectRoot, `.${requestPath}`);
    } catch (error) {
      response.writeHead(400);
      response.end('Invalid request path');
      return;
    }

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
  const server = createAppServer();
  server.listen(port, host, () => {
    console.log(`Serving Zawadi Gift Shop at http://${host}:${port}`);
  });

  server.on('error', (error) => {
    console.error('Unable to start the storefront server:', error);
    process.exitCode = 1;
  });
}

module.exports = { createAppServer };
