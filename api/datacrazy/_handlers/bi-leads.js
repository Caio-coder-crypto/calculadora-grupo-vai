// ============================================================
// GET /api/datacrazy/bi-leads
// Leads normalizados para a análise de CANAL DE AQUISIÇÃO.
//
// POR QUE ESTE ENDPOINT EXISTE (ago/2026):
// O bi-data só traz /businesses. Lead sem negócio simplesmente não
// existe naquele dataset, e a data que ele carrega é a do NEGÓCIO,
// não a do lead. Resultado: a aba Origem nunca batia com a tela de
// Leads do CRM — que conta leads por data de criação DO LEAD, em
// todas as pipelines, incluindo quem ainda não virou negócio.
// Aquisição se mede por lead; conversão/receita se mede por negócio.
//
// Registro enxuto (~120 B) — dá pra trazer bem mais por chunk que deals.
// Cache em memória por 60s, por (chave + chunk). Mesmo contrato de
// paginação do bi-data: o front repete com leadsSkip até hasMore=false.
// ============================================================

const { dcGet, send, sendError, getValidatedKey, handleOptions } = require('../_client');

if (!globalThis.__dcBiLeadsCache) globalThis.__dcBiLeadsCache = new Map();
const cache = globalThis.__dcBiLeadsCache;
const CACHE_TTL_MS = 60_000;

const LEAD_PAGE = 1000;    // take por página (mesmo teto da API usado em /businesses)
const MAX_CHUNK = 5000;    // teto por resposta (~600 KB, folgado sob o limite do Vercel)

function cacheKey(apiKey) {
  return apiKey ? apiKey.slice(-16) : 'anon';
}

// Só o que a análise de canal precisa. Nada de telefone/email —
// payload menor e sem PII desnecessária trafegando.
function normalizeLead(l) {
  return {
    id: l.id,
    createdAt: l.createdAt,
    source: l.source || '',
    attendantId: l.attendantId || null,
    tags: (l.tags || []).map(t => t.name).filter(Boolean)
  };
}

async function fetchLeadsChunk(apiKey, skip, take) {
  const nPages = Math.ceil(take / LEAD_PAGE);
  const promises = [];
  for (let i = 0; i < nPages; i++) {
    promises.push(dcGet(apiKey, '/leads', { skip: skip + i * LEAD_PAGE, take: LEAD_PAGE }));
  }
  const results = await Promise.all(promises);
  const raw = [];
  for (const r of results) raw.push(...(r.data || []));
  // /leads devolve `count` = total REAL da base (não muda com skip).
  const total = results[0]?.count ?? (skip + raw.length);
  return { leads: raw.map(normalizeLead), total };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const force = req.query.force === '1';
    const leadsSkip = Math.max(0, parseInt(req.query.leadsSkip || '0', 10) || 0);
    const leadsTake = Math.min(MAX_CHUNK, Math.max(1, parseInt(req.query.leadsTake || String(MAX_CHUNK), 10) || MAX_CHUNK));
    const chunkKey = `${cacheKey(apiKey)}:${leadsSkip}:${leadsTake}`;

    if (!force) {
      const cached = cache.get(chunkKey);
      if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
        return send(res, 200, { ...cached.payload, cached: true, cacheAgeMs: Date.now() - cached.at });
      }
    }

    const { leads, total } = await fetchLeadsChunk(apiKey, leadsSkip, leadsTake);
    const hasMore = leads.length > 0 && (leadsSkip + leads.length) < total;

    const payload = {
      leads,
      leadsSkip,
      leadsReturned: leads.length,
      leadsTotal: total,
      hasMore,
      fetchedAt: new Date().toISOString()
    };

    cache.set(chunkKey, { at: Date.now(), payload });
    send(res, 200, payload);
  } catch (err) {
    sendError(res, err);
  }
};
