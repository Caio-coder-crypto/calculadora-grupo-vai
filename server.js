// ============================================================
// Servidor de desenvolvimento local
// Serve arquivos estáticos (index.html, png, etc) e roteia
// /api/datacrazy/* para os módulos correspondentes em api/datacrazy/
//
// Uso: node server.js
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Carrega .env.local manualmente (sem dependências externas)
function loadEnv() {
  const envPath = path.join(__dirname, '.env.local');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) return;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  });
}
loadEnv();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  // '.json' fora da allowlist de propósito: o dev server serve a raiz do projeto
  // (nenhum asset .json é usado pelo front; dados vêm de /api/*).
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8'
};

// Hot reload: invalida TODOS os módulos em api/* a cada requisição
// (inclui _client.js, _auth.js que são compartilhados pelos handlers)
function invalidateApiCache() {
  const apiDir = path.join(ROOT, 'api');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(apiDir)) {
      delete require.cache[key];
    }
  }
}

function loadApi(group, name) {
  // Handlers consolidados vivem em _handlers/ (o Vercel só cria 1 função por grupo);
  // o dev server resolve direto pelo nome — primeiro _handlers/, depois a raiz do grupo.
  for (const rel of [path.join('api', group, '_handlers', name + '.js'), path.join('api', group, name + '.js')]) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) return require(full);
  }
  return null;
}

// Helper: wrapper que adiciona .status() e .send() compatíveis com Vercel
function wrapResponse(res) {
  res.status = function(code) { this.statusCode = code; return this; };
  res.send = function(data) {
    if (typeof data === 'object' && !Buffer.isBuffer(data)) {
      if (!this.getHeader('Content-Type')) {
        this.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      this.end(JSON.stringify(data));
    } else {
      this.end(data);
    }
    return this;
  };
  res.json = function(data) {
    this.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.end(JSON.stringify(data));
    return this;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  // Hot reload: invalida cache de todos os módulos em api/datacrazy/
  invalidateApiCache();

  const parsed = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsed.pathname);
  req.query = parsed.query;

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  // ---- API ROUTES ----
  // Aceita /api/datacrazy/*, /api/admin/*, /api/meta/* e /api/google/*
  const apiMatch = pathname.match(/^\/api\/(datacrazy|kommo|admin|meta|google|calcom)\/([\w-]+)\/?$/);
  if (apiMatch) {
    const group = apiMatch[1];
    const name = apiMatch[2];
    if (name.startsWith('_')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: true, message: 'Not found' }));
      return;
    }
    const handler = loadApi(group, name);
    if (!handler) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: true, message: `Function ${group}/${name} não encontrada` }));
      return;
    }
    try {
      wrapResponse(res);
      await handler(req, res);
    } catch (err) {
      console.error('[api error]', err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: true, message: err.message }));
    }
    return;
  }

  // ---- STATIC FILES ----
  // SEGURANÇA: a raiz deste dev server é o diretório do projeto — que aqui é o
  // próprio home do usuário. Sem as duas travas abaixo, um GET /.env.local
  // devolveria DATACRAZY_API_KEY/SUPABASE_SERVICE_KEY/ADMIN_PASSWORD em texto puro
  // (e /.ssh, /.aws/credentials, /.claude.json). Servimos SÓ tipos conhecidos e
  // NUNCA dotfiles/dotdirs.
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(ROOT, pathname);

  // Segurança básica: não permite sair da raiz
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  // Bloqueia qualquer segmento que comece com ponto (.env.local, .ssh, .git, ...)
  if (pathname.split('/').some(seg => seg.startsWith('.'))) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('404 Not Found');
    return;
  }

  // Allowlist de extensão: sem fallback octet-stream (que servia QUALQUER arquivo)
  const extReq = path.extname(filePath).toLowerCase();
  if (!MIME[extReq]) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('404 Not Found');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('404 Not Found: ' + pathname);
      return;
    }
    res.setHeader('Content-Type', MIME[extReq]);
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(filePath).pipe(res);
  });
});

// Bind SOMENTE em loopback: dev server nunca fica exposto na rede local.
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║  Grupo VAI · Calculadora WhatsApp API                ║');
  console.log('  ║  Servidor de desenvolvimento local                   ║');
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log('  ║  ▸ HTML:   http://localhost:' + PORT + '                       ║');
  console.log('  ║  ▸ API:    http://localhost:' + PORT + '/api/datacrazy/summary ║');
  console.log('  ║                                                      ║');
  console.log('  ║  Pressione Ctrl+C para parar.                        ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  DATACRAZY_API_KEY:', process.env.DATACRAZY_API_KEY ? '✓ configurada' : '✗ AUSENTE — confira .env.local');
  console.log('');
});
