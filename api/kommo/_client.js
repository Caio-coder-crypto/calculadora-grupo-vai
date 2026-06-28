// ============================================================
// Cliente HTTP do Kommo (ex-amoCRM) — espelha o papel do api/datacrazy/_client.js,
// mas a API do Kommo é por SUBDOMÍNIO + Bearer (token de longa duração), não header de chave.
//
// Config (qualquer um dos dois caminhos):
//   - Header:  X-Kommo-Subdomain + X-Kommo-Token   (multi-tenant, futuro)
//   - Env var: KOMMO_SUBDOMAIN + KOMMO_TOKEN        (single-tenant, teste atual)
//
// Base: https://{subdomain}.kommo.com/api/v4
// Paginação v4: ?limit=250&page=N até _links.next sumir (ou 204 = vazio).
// ============================================================

function getConfig(req) {
  const h = (req && req.headers) || {};
  const token = h['x-kommo-token'] || h['X-Kommo-Token'] || process.env.KOMMO_TOKEN || '';
  const sub   = (h['x-kommo-subdomain'] || h['X-Kommo-Subdomain'] || process.env.KOMMO_SUBDOMAIN || '')
    .toString().trim().replace(/\.kommo\.com.*$/i, '').replace(/^https?:\/\//i, '');
  if (!token || !sub) {
    const e = new Error('Kommo não configurado. Defina KOMMO_SUBDOMAIN e KOMMO_TOKEN (ou envie X-Kommo-Subdomain / X-Kommo-Token).');
    e.status = 401; e.code = 'NO_KOMMO_CONFIG';
    throw e;
  }
  return { token, sub, base: `https://${sub}.kommo.com/api/v4` };
}

async function kGet(cfg, path, query, attempt = 0) {
  const url = new URL(cfg.base + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' } });
  // Rate-limit (429) ou erro transitório (5xx): espera e tenta de novo (NUNCA tratar como "fim").
  if ((r.status === 429 || r.status >= 500) && attempt < 4) {
    const ra = parseInt(r.headers.get('Retry-After') || '0', 10);
    const wait = ra > 0 ? ra * 1000 : 400 * Math.pow(2, attempt);   // 0.4s, 0.8s, 1.6s, 3.2s
    await new Promise(s => setTimeout(s, wait));
    return kGet(cfg, path, query, attempt + 1);
  }
  if (r.status === 204) return { _empty: true };           // coleção vazia
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch {
    const e = new Error(`Resposta inesperada do Kommo (HTTP ${r.status})`); e.status = r.status; throw e;
  }
  if (!r.ok) {
    const e = new Error((j && (j.detail || j.title)) || `Kommo HTTP ${r.status}`);
    e.status = r.status; e.code = 'KOMMO_ERROR'; e.body = j;
    throw e;
  }
  return j;
}

// Pagina uma coleção v4 inteira, em LOTES PARALELOS (rápido e sob o rate-limit ~7/s do Kommo).
// entity = chave dentro de _embedded (ex.: 'leads','users','pipelines').
async function kGetAll(cfg, path, entity, query, opts = {}) {
  const batch = opts.batch || 4;          // páginas em paralelo (4 fica sob o rate-limit ~7/s do Kommo)
  const maxPages = opts.maxPages || 200;
  let out = [], page = 1, done = false;
  while (!done && page <= maxPages) {
    const nums = [];
    for (let i = 0; i < batch && page <= maxPages; i++) nums.push(page++);
    // SEM catch->empty: kGet já faz retry no 429; se falhar de vez, propaga (melhor erro do que dado truncado).
    const results = await Promise.all(nums.map(pg =>
      kGet(cfg, path, Object.assign({ limit: 250, page: pg }, query || {}))
    ));
    for (const j of results) {
      if (j._empty) { done = true; continue; }
      const arr = (j._embedded && j._embedded[entity]) || [];
      out.push(...arr);
      if (arr.length < 250) done = true;   // página incompleta = última (sinal confiável de fim)
    }
  }
  return out;
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(obj));
}
function sendError(res, err) {
  send(res, err.status || 500, { error: true, code: err.code || 'ERR', message: err.message || 'erro' });
}
function handleOptions(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kommo-Subdomain, X-Kommo-Token');
  res.statusCode = 204; res.end();
}

module.exports = { getConfig, kGet, kGetAll, send, sendError, handleOptions };
