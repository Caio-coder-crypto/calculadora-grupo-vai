// ============================================================
// POST /api/datacrazy/prospect
// Esteira de prospecção OUTBOUND nativa (sem Claude/sem planilha):
//   1. Roda o Actor da Apify (Google Maps) e já recebe os negócios
//   2. Pra cada negócio: cria LEAD (com a tag) + cria DEAL no funil de destino
//   3. O DataHub/BI lê /businesses e mede o canal "Outbound" automaticamente
//
// Pré-requisito de servidor: variável de ambiente APIFY_TOKEN (token da conta Apify).
// Auth: header X-DataCrazy-Key (mesmo kill-switch dos outros endpoints).
//
// Body (JSON):
//   { segment, location, quantity?, pipelineId, tag?, minStars?, actor? }
// ============================================================

const { dcGet, dcPost, getValidatedKey, send, sendError } = require('./_client');

const APIFY_TOKEN   = process.env.APIFY_TOKEN || '';
const DEFAULT_ACTOR = 'compass~crawler-google-places';  // Google Maps Scraper (compass)
const MAX_QTY       = 60;                                // teto por run (custo + timeout)

function corsPreflight(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DataCrazy-Key');
  res.statusCode = 204;
  res.end();
}

// Lê o body JSON (no Vercel já vem parseado em req.body; no server.js local vem como stream).
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

async function handler(req, res) {
  if (req.method === 'OPTIONS') return corsPreflight(res);
  if (req.method !== 'POST') return send(res, 405, { error: true, code: 'METHOD', message: 'Use POST.' });

  try {
    const apiKey = await getValidatedKey(req);

    if (!APIFY_TOKEN) {
      return send(res, 503, {
        error: true, code: 'NO_APIFY_TOKEN',
        message: 'APIFY_TOKEN não configurado no servidor.',
        hint: 'Adicione a variável de ambiente APIFY_TOKEN (token da sua conta Apify) no projeto da Vercel e faça redeploy.'
      });
    }

    const body = await readBody(req);
    const segment    = (body.segment || '').toString().trim();
    const location   = (body.location || '').toString().trim();
    const quantity   = Math.min(MAX_QTY, Math.max(1, parseInt(body.quantity || '20', 10) || 20));
    const pipelineId = (body.pipelineId || '').toString().trim();
    const tagName    = (body.tag || 'Outbound Apify').toString().trim();
    const minStars   = (body.minStars || '').toString().trim();
    const actor      = (body.actor || DEFAULT_ACTOR).toString().trim().replace('/', '~');

    if (!segment)    return send(res, 400, { error: true, message: 'Informe o segmento (ex.: "clínica de estética").' });
    if (!location)   return send(res, 400, { error: true, message: 'Informe a cidade/localização (ex.: "Fortaleza, CE, Brazil").' });
    if (!pipelineId) return send(res, 400, { error: true, message: 'Selecione o funil de destino.' });

    // 1) Descobre a 1ª etapa do funil (o POST /businesses exige stageId).
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

    // 3) Apify: roda o Actor de forma síncrona e já recebe os itens do dataset.
    const apifyInput = {
      searchStringsArray: [segment],
      locationQuery: location,
      maxCrawledPlacesPerSearch: quantity,
      language: 'pt-BR'
    };
    if (minStars) apifyInput.placeMinimumStars = minStars;

    const apifyUrl = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`
      + `?token=${encodeURIComponent(APIFY_TOKEN)}&timeout=120&memory=1024`;
    const apifyRes = await fetch(apifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apifyInput)
    });
    if (!apifyRes.ok) {
      const t = await apifyRes.text().catch(() => '');
      return send(res, 502, { error: true, code: 'APIFY_ERROR', message: `Apify HTTP ${apifyRes.status}: ${t.slice(0, 200)}` });
    }
    const places = await apifyRes.json().catch(() => []);
    const list = (Array.isArray(places) ? places : [])
      .filter(p => p && (p.title || p.name))
      .slice(0, quantity);

    if (!list.length) {
      return send(res, 200, { ok: true, scraped: 0, added: 0, failed: 0, pipelineId, stageId, tag: tagName, tagId,
        sample: [], errors: [], message: 'Nenhum negócio encontrado pra esse segmento/cidade.' });
    }

    // 4) Cria LEAD (com tag) + DEAL pra cada negócio, com concorrência controlada.
    const results = await mapPool(list, 4, async (p) => {
      const name = p.title || p.name;
      const phone = fmtPhoneBR(p.phoneUnformatted || p.phone);
      try {
        const lead = await dcPost(apiKey, '/leads', {
          name,
          phone: phone || undefined,
          source: `Apify · ${segment}`,
          site: p.website || undefined,
          tags: [{ id: tagId }]
        });
        const leadId = lead.id || lead.data?.id;
        if (!leadId) return { name, ok: false, error: 'lead criado sem id' };
        const deal = await dcPost(apiKey, '/businesses', { leadId, stageId });
        return { name, phone, ok: true, leadId, dealId: deal.id || deal.data?.id || null };
      } catch (e) {
        return { name, ok: false, error: (e.message || 'erro').slice(0, 140) };
      }
    });

    const added  = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    return send(res, 200, {
      ok: true,
      scraped: list.length,
      added: added.length,
      failed: failed.length,
      pipelineId, stageId, tag: tagName, tagId,
      sample: added.slice(0, 10).map(r => ({ name: r.name, phone: r.phone })),
      errors: failed.slice(0, 5),
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    return sendError(res, err);
  }
}

handler.config = { maxDuration: 60 };  // a esteira (Apify + writes) pode levar até ~1 min
module.exports = handler;
