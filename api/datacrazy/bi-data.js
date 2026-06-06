// ============================================================
// GET /api/datacrazy/bi-data
// Endpoint mestre do BI: puxa em paralelo deals + pipelines +
// stages + attendants + loss reasons e retorna dataset normalizado.
//
// Cache em memória por 60s (por chave de API) para evitar
// hammering na API do DataCrazy durante navegação entre abas.
// ============================================================

const { dcGetAll, dcGet, send, sendError, getValidatedKey, handleOptions } = require('./_client');

// Cache simples in-memory por API key (hash curto)
// Usa globalThis pra sobreviver ao hot-reload do dev server.
if (!globalThis.__dcBiCache) globalThis.__dcBiCache = new Map();
const cache = globalThis.__dcBiCache;
const CACHE_TTL_MS = 60_000;

function cacheKey(apiKey) {
  // Usa últimos 16 chars da key como ID (não loga a chave completa)
  return apiKey ? apiKey.slice(-16) : 'anon';
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const force = req.query.force === '1';
    const ck = cacheKey(apiKey);

    // Cache HIT
    if (!force) {
      const cached = cache.get(ck);
      if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
        return send(res, 200, { ...cached.payload, cached: true, cacheAgeMs: Date.now() - cached.at });
      }
    }

    // ---- Busca paralela ----
    // Limite de 15 páginas (3.000 deals) pra evitar timeout em CRMs grandes.
    // Pipelines/atendentes/motivos são listas pequenas, mantemos baixo limite.
    const [businessesRes, pipelinesRes, attendantsRes, lossReasonsRes] = await Promise.all([
      dcGetAll(apiKey, '/businesses', {}, 200, 15),       // ~3.000 deals (suficiente p/ BI)
      dcGetAll(apiKey, '/pipelines', {}, 50, 5),
      dcGetAll(apiKey, '/attendants/crm', {}, 100, 5),
      dcGetAll(apiKey, '/business-loss-reasons', {}, 100, 5)
    ]);

    // ---- Busca stages de cada pipeline em paralelo ----
    const pipelines = pipelinesRes.data;
    const stagesPromises = pipelines.map(p =>
      dcGet(apiKey, `/pipelines/${p.id}/stages`).then(r => ({ pipelineId: p.id, stages: r.data || [] }))
    );
    const stagesResults = await Promise.all(stagesPromises);

    // Constrói mapa stageId → { pipelineId, name, color, index }
    const stageMap = {};
    const stagesByPipeline = {};
    for (const { pipelineId, stages } of stagesResults) {
      stagesByPipeline[pipelineId] = stages;
      for (const s of stages) {
        stageMap[s.id] = { ...s, pipelineId };
      }
    }

    // ---- Normaliza deals ----
    const deals = businessesRes.data.map(b => ({
      id: b.id,
      code: b.code,
      createdAt: b.createdAt,
      lastMovedAt: b.lastMovedAt,
      statusChangedAt: b.statusChangedAt,
      stageId: b.stageId,
      stageName: b.stage?.name || stageMap[b.stageId]?.name || 'Sem etapa',
      stageColor: b.stage?.color || stageMap[b.stageId]?.color || '#94a3b8',
      stageIndex: stageMap[b.stageId]?.index ?? 999,
      pipelineId: stageMap[b.stageId]?.pipelineId || null,
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
      productsCount: b.productsCount || 0
    }));

    // ---- Payload final ----
    const payload = {
      counts: {
        deals: businessesRes.count,
        pipelines: pipelinesRes.count,
        attendants: attendantsRes.count,
        lossReasons: lossReasonsRes.count
      },
      deals,
      pipelines: pipelines.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        group: p.group,
        stagesCount: p.stagesCount,
        stages: (stagesByPipeline[p.id] || [])
          .sort((a, b) => a.index - b.index)
          .map(s => ({ id: s.id, name: s.name, color: s.color, index: s.index }))
      })),
      attendants: attendantsRes.data.map(a => ({
        id: a.id,
        userId: a.userId,
        name: a.name,
        email: a.email,
        phone: a.phone,
        image: a.image
      })),
      lossReasons: lossReasonsRes.data.map(lr => ({
        id: lr.id,
        name: lr.name,
        requiredJustification: lr.requiredJustification
      })),
      fetchedAt: new Date().toISOString()
    };

    // Cacheia
    cache.set(ck, { at: Date.now(), payload });

    send(res, 200, { ...payload, cached: false });
  } catch (err) {
    sendError(res, err);
  }
};
