// ============================================================
// GET /api/datacrazy/bi-data
// Endpoint mestre do BI. Retorna deals normalizados + metadados
// (pipelines/stages/attendants/loss reasons).
//
// CARGA EM CHUNKS (jun/2026): a base pode ter dezenas de milhares de
// negócios e a API do DataCrazy ignora filtros server-side, então o
// front precisa do dataset inteiro pra calcular no cliente. Como o
// Vercel capa a resposta serverless (~4,5 MB) e o deal "enxuto" ≈ 618 B,
// cada resposta entrega no máximo MAX_CHUNK deals. O front pagina:
//   1) chama dealsSkip=0  → recebe metadados + total + 1ª leva
//   2) repete com dealsSkip=3000, 6000, ... até hasMore=false
// Assim cada invocação fica sob o limite de tamanho E de timeout.
//
// Normalização: o próprio deal de /businesses já traz `stage` embutido
// (com index/color/pipeline.id), então NÃO depende do fetch de stages —
// chunks após o 1º só puxam deals (rápido).
//
// Cache em memória por 60s, por (chave + chunk).
// ============================================================

const { dcGetAll, dcGet, send, sendError, getValidatedKey, handleOptions } = require('../_client');

if (!globalThis.__dcBiCache) globalThis.__dcBiCache = new Map();
const cache = globalThis.__dcBiCache;
const CACHE_TTL_MS = 60_000;

const DEAL_PAGE = 1000;   // take por página (a API aceita até 1000; 2000 volta vazio)
const MAX_CHUNK = 3000;   // teto de deals por resposta (~1,8 MB, sob o limite do Vercel)

function cacheKey(apiKey) {
  // hash da chave inteira: indexar por sufixo permitia colisao entre tenants
  return apiKey ? require('crypto').createHash('sha256').update(apiKey).digest('hex') : 'anon';
}

// Normaliza um negócio bruto da API para o formato enxuto que o front usa.
// Usa o `stage` embutido no próprio deal (não precisa de stageMap externo).
function normalizeDeal(b) {
  return {
    id: b.id,
    code: b.code,
    createdAt: b.createdAt,
    lastMovedAt: b.lastMovedAt,
    statusChangedAt: b.statusChangedAt,
    stageId: b.stageId,
    stageName: b.stage?.name || 'Sem etapa',
    stageColor: b.stage?.color || '#94a3b8',
    stageIndex: b.stage?.index ?? 999,
    pipelineId: b.stage?.pipeline?.id || null,
    attendantId: b.attendantId,
    attendantName: b.attendant?.name || 'Sem atendente',
    leadId: b.leadId,
    leadName: b.lead?.name || '',
    leadPhone: b.lead?.phone || '',   // ex.: "558592804369" (55 + DDD + número) — usado no mapa por estado
    leadSource: b.lead?.source || '', // origem nativa do CRM (além das tags)
    leadTags: (b.lead?.tags || []).map(t => t.name).filter(Boolean),
    total: b.total || 0,
    status: b.status,
    lossReasonId: b.lossReasonId,
    productsCount: b.productsCount || 0,
    // Itens do pedido (só clientes com catálogo populam isto).
    // unitPrice = preço praticado neste deal; catalogPrice = preço de tabela (p/ detectar desconto).
    products: (b.products || []).map(p => ({
      id: p.product?.id || p.id || null,
      sku: p.product?.id_sku || '',
      name: p.product?.name || 'Produto sem nome',
      // Number(...) blinda contra string ("3") e mantém fração de propósito (venda por peso/kg).
      quantity: Number(p.quantity) || 0,
      unitPrice: Number(p.price ?? p.product?.price) || 0,
      catalogPrice: Number(p.product?.price) || 0,
      total: Number(p.total) || 0
    }))
  };
}

// Busca um chunk de deals com páginas EM PARALELO (mais rápido, fica sob o timeout).
// Retorna { deals (normalizados), total (count real da base) }.
async function fetchDealsChunk(apiKey, skip, take) {
  const nPages = Math.ceil(take / DEAL_PAGE);
  const promises = [];
  for (let i = 0; i < nPages; i++) {
    promises.push(dcGet(apiKey, '/businesses', { skip: skip + i * DEAL_PAGE, take: DEAL_PAGE }));
  }
  const results = await Promise.all(promises);
  const raw = [];
  for (const r of results) raw.push(...(r.data || []));
  // /businesses retorna `count` = total REAL da base (não muda com skip).
  const total = results[0]?.count ?? (skip + raw.length);
  return { deals: raw.map(normalizeDeal), total };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const force = req.query.force === '1';
    const dealsSkip = Math.max(0, parseInt(req.query.dealsSkip || '0', 10) || 0);
    const dealsTake = Math.min(MAX_CHUNK, Math.max(1, parseInt(req.query.dealsTake || String(MAX_CHUNK), 10) || MAX_CHUNK));
    const ck = cacheKey(apiKey);
    const chunkKey = `${ck}:${dealsSkip}:${dealsTake}`;

    // Cache HIT (por chunk)
    if (!force) {
      const cached = cache.get(chunkKey);
      if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
        return send(res, 200, { ...cached.payload, cached: true, cacheAgeMs: Date.now() - cached.at });
      }
    }

    // ---- Chunk de deals (sempre) ----
    const { deals, total } = await fetchDealsChunk(apiKey, dealsSkip, dealsTake);
    const hasMore = deals.length > 0 && (dealsSkip + deals.length) < total;

    const payload = {
      deals,
      dealsSkip,
      dealsReturned: deals.length,
      dealsTotal: total,
      hasMore,
      counts: { deals: total },
      fetchedAt: new Date().toISOString()
    };

    // ---- Metadados (pipelines/stages/atendentes/motivos) SÓ no 1º chunk ----
    // São listas pequenas, usadas nos filtros e no funil. Chunks seguintes não precisam.
    if (dealsSkip === 0) {
      const [pipelinesRes, attendantsRes, lossReasonsRes] = await Promise.all([
        dcGetAll(apiKey, '/pipelines', {}, 50, 5),
        dcGetAll(apiKey, '/attendants/crm', {}, 100, 5),
        dcGetAll(apiKey, '/business-loss-reasons', {}, 100, 5)
      ]);

      const pipelines = pipelinesRes.data;
      const stagesResults = await Promise.all(pipelines.map(p =>
        dcGet(apiKey, `/pipelines/${p.id}/stages`).then(r => ({ pipelineId: p.id, stages: r.data || [] }))
      ));
      const stagesByPipeline = {};
      for (const { pipelineId, stages } of stagesResults) stagesByPipeline[pipelineId] = stages;

      payload.pipelines = pipelines.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        group: p.group,
        stagesCount: p.stagesCount,
        stages: (stagesByPipeline[p.id] || [])
          .sort((a, b) => a.index - b.index)
          .map(s => ({ id: s.id, name: s.name, color: s.color, index: s.index }))
      }));
      payload.attendants = attendantsRes.data.map(a => ({
        id: a.id, userId: a.userId, name: a.name, email: a.email, phone: a.phone, image: a.image
      }));
      payload.lossReasons = lossReasonsRes.data.map(lr => ({
        id: lr.id, name: lr.name, requiredJustification: lr.requiredJustification
      }));
      payload.counts = {
        deals: total,
        pipelines: pipelinesRes.count,
        attendants: attendantsRes.count,
        lossReasons: lossReasonsRes.count
      };
    }

    cache.set(chunkKey, { at: Date.now(), payload });
    send(res, 200, { ...payload, cached: false });
  } catch (err) {
    sendError(res, err);
  }
};
