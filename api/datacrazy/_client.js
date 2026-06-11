// ============================================================
// Cliente HTTP para a API do DataCrazy (multi-tenant)
// Integra Supabase como KILL SWITCH de inadimplência.
//
// Fluxo de validação:
//   1. Extrai chave do header X-DataCrazy-Key
//   2. Consulta Supabase: SELECT is_active FROM clients WHERE api_key = <chave>
//   3. Não encontrou           → 401 (chave não autorizada)
//   4. Encontrou + is_active=false → 403 (assinatura inativa)
//   5. Encontrou + is_active=true  → libera chamada à DataCrazy (fluxo normal)
//
// Fallback: chave vinda do env DATACRAZY_API_KEY bypassa validação (uso admin).
// Cache de validação: 60s por chave (evita hammering no Supabase).
// ============================================================

const API_BASE      = process.env.DATACRAZY_API_BASE || 'https://api.g1.datacrazy.io/api/v1';
const FALLBACK_KEY  = process.env.DATACRAZY_API_KEY || '';
const SUPABASE_URL  = process.env.SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';

// ---- Supabase client (lazy, só instancia se as env vars existem) ----
let supabase = null;
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);
if (SUPABASE_ENABLED) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    console.log('[supabase] Kill switch ATIVO — validando chaves contra tabela clients');
  } catch (err) {
    console.warn('[supabase] Falha ao carregar SDK:', err.message);
  }
} else {
  console.warn('[supabase] Kill switch DESATIVADO — sem SUPABASE_URL/SUPABASE_SERVICE_KEY (modo dev/legado)');
}

// ---- Cache de validação (60s por chave) ----
// Usa globalThis pra sobreviver ao hot-reload do dev.
if (!globalThis.__dcAuthCache) globalThis.__dcAuthCache = new Map();
const authCache = globalThis.__dcAuthCache;
const AUTH_CACHE_TTL_MS = 60_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Extrai a API key do request (sem validar).
 */
function getApiKey(req) {
  const headerKey = req.headers['x-datacrazy-key'] || req.headers['X-DataCrazy-Key'];
  if (headerKey && typeof headerKey === 'string' && headerKey.trim()) {
    return { key: headerKey.trim(), source: 'header' };
  }
  if (req.query?.key && typeof req.query.key === 'string') {
    return { key: req.query.key.trim(), source: 'query' };
  }
  return { key: FALLBACK_KEY || null, source: 'env' };
}

/**
 * Valida a chave contra o Supabase (com cache de 60s).
 * Throws com status 401/403 se inválida/inativa.
 * Bypass: se Supabase não está configurado, OU se a chave vem do env, libera.
 */
async function validateApiKey(key, source) {
  // Bypass: env fallback (admin/dev) ou Supabase não configurado
  if (source === 'env' || !SUPABASE_ENABLED || !supabase) return true;

  // Cache hit
  const cached = authCache.get(key);
  if (cached && (Date.now() - cached.at) < AUTH_CACHE_TTL_MS) {
    if (cached.status === 'active') return true;
    throwAuthError(cached.status);
  }

  // Consulta Supabase
  let row, error;
  try {
    const res = await supabase
      .from('clients')
      .select('is_active, empresa')
      .eq('api_key', key)
      .maybeSingle();
    row = res.data;
    error = res.error;
  } catch (e) {
    error = e;
  }

  if (error) {
    console.error('[supabase] Erro na consulta:', error.message || error);
    const err = new Error('Erro ao validar acesso. Tente novamente em instantes.');
    err.status = 500;
    err.code = 'AUTH_ERROR';
    throw err;
  }

  if (!row) {
    authCache.set(key, { at: Date.now(), status: 'unknown' });
    throwAuthError('unknown');
  }

  if (!row.is_active) {
    authCache.set(key, { at: Date.now(), status: 'inactive', empresa: row.empresa });
    throwAuthError('inactive');
  }

  authCache.set(key, { at: Date.now(), status: 'active', empresa: row.empresa });
  return true;
}

function throwAuthError(status) {
  if (status === 'inactive') {
    const err = new Error('Assinatura inativa');
    err.status = 403;
    err.code = 'SUBSCRIPTION_INACTIVE';
    throw err;
  }
  // unknown ou qualquer outro
  const err = new Error('Chave não autorizada. Entre em contato com o suporte.');
  err.status = 401;
  err.code = 'KEY_NOT_FOUND';
  throw err;
}

/**
 * Retorna o NOME (empresa) cadastrado no painel (Supabase) para a chave dada.
 * Usado para exibir no cabeçalho do dashboard "qual cliente estou vendo".
 * Reaproveita o cache de validação quando disponível; senão consulta o Supabase.
 * Retorna null se: chave ausente, Supabase desativado, chave vinda do env (admin)
 * ou cliente não encontrado.
 */
async function getClientEmpresa(key) {
  if (!key || !SUPABASE_ENABLED || !supabase) return null;

  // Cache hit (validateApiKey já guarda a empresa para chaves ativas)
  const cached = authCache.get(key);
  if (cached && cached.empresa) return cached.empresa;

  try {
    const { data } = await supabase
      .from('clients')
      .select('empresa')
      .eq('api_key', key)
      .maybeSingle();
    return data?.empresa || null;
  } catch (e) {
    console.warn('[supabase] getClientEmpresa falhou:', e.message || e);
    return null;
  }
}

/**
 * Helper conveniente: extrai chave + valida + devolve a chave usável.
 * Use este nos handlers em vez de getApiKey() direto.
 */
async function getValidatedKey(req) {
  const { key, source } = getApiKey(req);
  if (!key) {
    const err = new Error('API key ausente. Configure sua chave DataCrazy no botão ⚙️ da calculadora.');
    err.status = 401;
    err.code = 'NO_KEY';
    throw err;
  }
  await validateApiKey(key, source);  // throws 401/403/500 se inválido
  return key;
}

/**
 * Faz uma chamada GET autenticada na API do DataCrazy.
 * Retry com backoff exponencial em 429 (rate limit) e 503.
 */
async function dcGet(apiKey, path, query = {}) {
  if (!apiKey) {
    const err = new Error('API key ausente.');
    err.status = 401;
    err.code = 'NO_KEY';
    throw err;
  }
  const url = new URL(API_BASE + path);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  });

  const MAX_RETRIES = 3;
  const BACKOFF_MS  = [400, 1200, 3000];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      }
    });

    if (res.ok) return res.json();

    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
      const delay = retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS[attempt];
      console.warn(`[datacrazy] HTTP ${res.status} em ${path} — aguardando ${delay}ms (tentativa ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      continue;
    }

    const text = await res.text().catch(() => '');
    const err = new Error(`DataCrazy ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

/**
 * Paginação automática com delay anti-burst (80ms entre páginas).
 *
 * opts.ignoreCount: quando true, NÃO confia no campo `count` da resposta como
 *   total (alguns endpoints capam o count — ex.: /conversations capa em 999).
 *   Nesse modo só para quando uma página vem incompleta (fim real) ou ao bater
 *   maxPages/deadline. O `count` retornado passa a ser o nº de itens realmente lidos.
 * opts.deadlineMs: teto de tempo (ms) — aborta a paginação antes do timeout serverless.
 *
 * Retorna { count, data, truncated }. `truncated=true` indica que parou por
 * limite (maxPages/deadline) e o total pode ser maior que o lido.
 */
async function dcGetAll(apiKey, path, baseQuery = {}, pageSize = 200, maxPages = 50, opts = {}) {
  const ignoreCount = !!opts.ignoreCount;
  const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : null;
  const out = [];
  let total = null;
  let truncated = false;
  let page = 0;
  for (; page < maxPages; page++) {
    if (page > 0) await sleep(80);
    if (deadline && Date.now() > deadline) { truncated = true; break; }
    const res = await dcGet(apiKey, path, { ...baseQuery, skip: page * pageSize, take: pageSize });
    total = res.count;
    const batch = res.data || [];
    out.push(...batch);
    if (batch.length < pageSize) break;                              // fim real dos dados
    if (!ignoreCount && total != null && out.length >= total) break; // parada por count (ok p/ leads, onde count é fiel)
  }
  if (page >= maxPages) truncated = true;
  return { count: ignoreCount ? out.length : (total ?? out.length), data: out, truncated };
}

function send(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DataCrazy-Key');
  res.status(status).send(JSON.stringify(payload));
}

function sendError(res, err) {
  console.error('[datacrazy]', err.message || err);
  const status = err?.status || (err?.code === 'NO_KEY' ? 401 : 500);
  send(res, status, {
    error: true,
    code: err?.code || 'INTERNAL',
    message: err?.message || 'Erro desconhecido',
    hint: err?.code === 'NO_KEY'
      ? 'Clique no botão ⚙️ Configurar e cole sua chave da API DataCrazy.'
      : err?.code === 'KEY_NOT_FOUND'
        ? 'A chave fornecida não está cadastrada no sistema. Fale com o suporte do Grupo VAI.'
        : err?.code === 'SUBSCRIPTION_INACTIVE'
          ? 'Assinatura suspensa. Regularize com o suporte para reativar o acesso.'
          : err?.status === 401
            ? 'A chave da API DataCrazy é inválida ou expirou.'
            : undefined,
    timestamp: new Date().toISOString()
  });
}

function handleOptions(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DataCrazy-Key');
  res.statusCode = 204;
  res.end();
}

module.exports = {
  dcGet,
  dcGetAll,
  send,
  sendError,
  getApiKey,           // mantido por compatibilidade (uso interno)
  getValidatedKey,     // novo — use este nos handlers
  getClientEmpresa,    // nome do cliente (empresa) p/ cabeçalho do painel
  handleOptions,
  API_BASE,
  SUPABASE_ENABLED
};
