// ============================================================
// POST /api/datacrazy/prospect
// Esteira de prospecção OUTBOUND nativa (sem Claude/sem planilha), em 2 passos:
//   action:'search'  → roda o Actor da Apify (Google Maps) e DEVOLVE a lista (não grava).
//   action:'import'  → recebe a lista revisada e cria LEAD (com tag) + DEAL no funil.
//
// O DataHub/BI lê /businesses e mede o canal "Outbound" automaticamente (pela tag).
//
// Pré-requisito (só p/ 'search'): env var APIFY_TOKEN (token da conta Apify).
// Auth: header X-DataCrazy-Key (mesmo kill-switch dos outros endpoints).
// ============================================================

const { dcGet, dcPost, getValidatedKey, send, sendError } = require('../_client');

const APIFY_TOKEN   = process.env.APIFY_TOKEN || '';
const DEFAULT_ACTOR = 'compass~crawler-google-places';  // Google Maps Scraper (compass)
const MAX_QTY       = 60;                                // teto por busca (custo + timeout)

function corsPreflight(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DataCrazy-Key');
  res.statusCode = 204;
  res.end();
}

// Lê o body JSON (Vercel já parseia em req.body; server.js local entrega como stream).
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Telefone BR no formato +55DDDNUMERO (a partir do phoneUnformatted do Maps).
function fmtPhoneBR(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/\D/g, '');
  if (!d) return '';
  if (!d.startsWith('55')) d = '55' + d;
  return '+' + d;
}

// Pool de concorrência simples (não estoura rate-limit nem o timeout serverless).
async function mapPool(items, concurrency, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- PASSO 1: busca no Apify (sem gravar nada) ----
async function doSearch(body, res) {
  if (!APIFY_TOKEN) {
    return send(res, 503, {
      error: true, code: 'NO_APIFY_TOKEN',
      message: 'APIFY_TOKEN não configurado no servidor.',
      hint: 'Adicione a variável de ambiente APIFY_TOKEN (token da sua conta Apify) no projeto da Vercel e faça redeploy.'
    });
  }
  const segment  = (body.segment || '').toString().trim();
  const location = (body.location || '').toString().trim();
  const quantity = Math.min(MAX_QTY, Math.max(1, parseInt(body.quantity || '20', 10) || 20));
  const minStars = (body.minStars || '').toString().trim();
  // ALLOWLIST de Actor: o valor ia interpolado no path da API da Apify junto com o
  // token da conta. O replace('/','~') trocava só a PRIMEIRA barra, então
  // "a/../../v2/qualquer-coisa" virava POST autenticado em qualquer endpoint da
  // Apify — e mesmo sem traversal dava pra rodar qualquer Actor pago da conta.
  const ACTOR_ALLOWLIST = new Set([DEFAULT_ACTOR, 'compass~crawler-google-places']);
  const actorRaw = (body.actor || DEFAULT_ACTOR).toString().trim().replace(/\//g, '~');
  if (!ACTOR_ALLOWLIST.has(actorRaw) || !/^[a-zA-Z0-9_-]+~[a-zA-Z0-9_.-]+$/.test(actorRaw)) {
    return send(res, 400, { error: true, code: 'ACTOR_NOT_ALLOWED', message: 'Actor não permitido.' });
  }
  const actor = actorRaw;

  if (!segment)  return send(res, 400, { error: true, message: 'Informe o segmento (ex.: "clínica de estética").' });
  if (!location) return send(res, 400, { error: true, message: 'Informe a cidade/localização (ex.: "Fortaleza, CE, Brazil").' });

  const apifyInput = {
    searchStringsArray: [segment],
    locationQuery: location,
    maxCrawledPlacesPerSearch: quantity,
    language: 'pt-BR',
    scrapeContacts: true   // enriquece com redes sociais (Instagram) + e-mails a partir do site
  };
  if (minStars) apifyInput.placeMinimumStars = minStars;

  // Token da Apify via header Authorization (em query string ele fica gravado no
  // access log do destino e em qualquer intermediário do caminho).
  const apifyUrl = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`
    + `?timeout=120&memory=1024`;
  const apifyRes = await fetch(apifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + APIFY_TOKEN },
    body: JSON.stringify(apifyInput)
  });
  if (!apifyRes.ok) {
    const t = await apifyRes.text().catch(() => '');
    console.error('[prospect] Apify HTTP', apifyRes.status, t.slice(0, 300));
    return send(res, 502, { error: true, code: 'APIFY_ERROR', message: 'Falha na busca de prospecção. Tente novamente.' });
  }
  const places = await apifyRes.json().catch(() => []);
  const items = (Array.isArray(places) ? places : [])
    .filter(p => p && (p.title || p.name))
    .slice(0, quantity)
    .map(p => ({
      name: p.title || p.name,
      phone: fmtPhoneBR(p.phoneUnformatted || p.phone),
      website: p.website || '',
      instagram: (Array.isArray(p.instagrams) && p.instagrams[0]) || p.instagram
        || (p.contactDetails && Array.isArray(p.contactDetails.instagrams) && p.contactDetails.instagrams[0]) || '',
      rating: p.totalScore || null,
      reviews: p.reviewsCount || 0,
      neighborhood: p.neighborhood || ''
    }));

  return send(res, 200, { ok: true, action: 'search', segment, location, count: items.length, items });
}

// ---- PASSO 2: importa a lista revisada pro CRM (cria lead+tag+deal) ----
async function doImport(apiKey, body, res) {
  const leads      = Array.isArray(body.leads) ? body.leads : [];
  const pipelineId = (body.pipelineId || '').toString().trim();
  // pipelineId entra no PATH do upstream: barra/".." reescreveriam a rota.
  if (pipelineId && !/^[a-zA-Z0-9_-]{6,64}$/.test(pipelineId)) {
    return send(res, 400, { error: true, message: 'Funil inválido.' });
  }
  const tagName    = (body.tag || 'Outbound Apify').toString().trim();
  const segment    = (body.segment || '').toString().trim();

  if (!leads.length) return send(res, 400, { error: true, message: 'Nenhum lead pra importar — faça a busca primeiro.' });
  if (!pipelineId)   return send(res, 400, { error: true, message: 'Selecione o funil de destino.' });

  // 1) 1ª etapa do funil (o POST /businesses exige stageId).
  const stagesRes = await dcGet(apiKey, `/pipelines/${pipelineId}/stages`);
  const stages = (stagesRes.data || []).slice().sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
  if (!stages.length) return send(res, 400, { error: true, message: 'Funil sem etapas ou inexistente.' });
  const stageId = stages[0].id;

  // 2) Tag: reaproveita se já existe (por nome), senão cria.
  let tagId = null;
  try {
    const tg = await dcGet(apiKey, '/tags', { search: tagName });
    const found = (tg.data || []).find(t => (t.name || '').toLowerCase() === tagName.toLowerCase());
    if (found) tagId = found.id;
  } catch (_) { /* segue e cria */ }
  if (!tagId) {
    const created = await dcPost(apiKey, '/tags', { name: tagName, color: '#10B981', description: 'Lead prospectado via Apify (outbound)' });
    tagId = created.id || created.data?.id || null;
  }

  // 3) Cria LEAD (com tag) + DEAL pra cada negócio (ordem preservada p/ casar com a tabela).
  const results = await mapPool(leads, 4, async (l) => {
    const name = (l.name || '').toString().trim();
    const phone = (l.phone || '').toString().trim();
    if (!name) return { name: '(sem nome)', phone, ok: false, error: 'sem nome' };
    try {
      const lead = await dcPost(apiKey, '/leads', {
        name,
        phone: phone || undefined,
        source: segment ? `Apify · ${segment}` : 'Apify · outbound',
        site: l.website || undefined,
        instagram: l.instagram || undefined,
        tags: [{ id: tagId }]
      });
      const leadId = lead.id || lead.data?.id;
      if (!leadId) return { name, phone, ok: false, error: 'lead criado sem id' };
      const deal = await dcPost(apiKey, '/businesses', { leadId, stageId });
      return { name, phone, ok: true, leadId, dealId: deal.id || deal.data?.id || null };
    } catch (e) {
      return { name, phone, ok: false, error: (e.message || 'erro').slice(0, 140) };
    }
  });

  const added  = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  return send(res, 200, {
    ok: true, action: 'import',
    added: added.length,
    failed: failed.length,
    pipelineId, stageId, tag: tagName, tagId,
    results,
    fetchedAt: new Date().toISOString()
  });
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') return corsPreflight(res);
  if (req.method !== 'POST') return send(res, 405, { error: true, code: 'METHOD', message: 'Use POST.' });

  try {
    const apiKey = await getValidatedKey(req);
    const body = await readBody(req);
    const action = (body.action || 'search').toString();

    if (action === 'import') return await doImport(apiKey, body, res);
    return await doSearch(body, res);  // 'search' (padrão)
  } catch (err) {
    return sendError(res, err);
  }
}

handler.config = { maxDuration: 60 };  // busca (Apify) e import (writes) podem levar ~1 min
module.exports = handler;
