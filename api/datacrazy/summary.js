// ============================================================
// GET /api/datacrazy/summary
// Endpoint AGREGADO: chama leads + conversations em paralelo
// e devolve um payload pronto para o dashboard renderizar.
//
// Query params:
//   - mixMarketing      (0-100, default 60)
//   - mixUtility        (0-100, default 30)
//   - mixAuth           (0-100, default 10)
//   - usdBrl            (decimal, default 5.00) — cotação aplicada
//   - officialInstances (CSV ids, opcional) — quando presente, calcula custo SÓ
//                       das conversas dessas instâncias. Útil pra clientes que
//                       têm WhatsApp Oficial + Evolution rodando lado a lado e
//                       só a oficial é cobrada pela Meta.
// ============================================================

const { dcGetAll, send, sendError, getValidatedKey, handleOptions } = require('./_client');

// Tarifas Meta para o Brasil (USD por conversa)
const RATES = {
  marketing: 0.0625,
  utility:   0.0068,
  auth:      0.0068,
  service:   0.0000
};

// Provider/engine que indicam API OFICIAL do WhatsApp (Meta) — ESSAS são cobradas.
// Evolution/Baileys/etc. NÃO têm custo por conversa da Meta.
const OFFICIAL_PROVIDERS = new Set([
  'OFFICIAL_API', 'META_OFFICIAL', 'META_API', 'CLOUD_API',
  'WHATSAPP_CLOUD_API', 'WABA', 'WHATSAPP_BUSINESS_API', 'WHATSAPP_BSP'
]);
function isOfficialInstance(inst) {
  if (!inst) return false;
  const p = (inst.provider || '').toUpperCase();
  const e = (inst.engine   || '').toUpperCase();
  return OFFICIAL_PROVIDERS.has(p) || OFFICIAL_PROVIDERS.has(e);
}

// ---- Cache em memória por chave de API ----
// Usa globalThis pra sobreviver ao hot-reload do dev server (server.js limpa
// require.cache a cada request). Em produção (Vercel) o módulo é reusado
// dentro da mesma instância Lambda — funciona normal.
const CACHE_TTL_MS = 60_000;
if (!globalThis.__dcSummaryCache) globalThis.__dcSummaryCache = new Map();
const cache = globalThis.__dcSummaryCache;
const cacheKey = (apiKey) => apiKey ? apiKey.slice(-16) : 'anon';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const q = req.query || {};
    const mix = {
      marketing: clamp(parseFloat(q.mixMarketing) || 60, 0, 100),
      utility:   clamp(parseFloat(q.mixUtility)   || 30, 0, 100),
      auth:      clamp(parseFloat(q.mixAuth)      || 10, 0, 100)
    };
    const usdBrl = parseFloat(q.usdBrl) || 5.00;

    // Normaliza mix para somar 100%
    const totalMix = mix.marketing + mix.utility + mix.auth;
    if (totalMix > 0) {
      mix.marketing = mix.marketing / totalMix;
      mix.utility   = mix.utility   / totalMix;
      mix.auth      = mix.auth      / totalMix;
    }

    // Custo médio ponderado (USD por conversa cobrável)
    const avgCostUSD = mix.marketing * RATES.marketing
                     + mix.utility   * RATES.utility
                     + mix.auth      * RATES.auth;

    // ---- Busca leads + conversations (com cache de 60s) ----
    // Os dados brutos são cacheados; os cálculos derivados (mix, cotação) rodam sempre.
    //
    // IMPORTANTE: limitamos a 10 páginas (2.000 registros) por endpoint pra evitar
    // timeout em clientes grandes (50k+ leads). O campo `total` continua exato (vem
    // do response.count da API), só as distribuições por source/tag/mês ficam baseadas
    // no sample dos 2.000 registros mais recentes — estatisticamente representativo
    // e suficiente pro Dashboard de custo (que projeta com base no ritmo).
    const ck = cacheKey(apiKey);
    const force = req.query.force === '1';
    let leadsRes, convsRes, fromCache = false;

    const cached = cache.get(ck);
    if (!force && cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
      leadsRes = cached.leadsRes;
      convsRes = cached.convsRes;
      fromCache = true;
    } else {
      [leadsRes, convsRes] = await Promise.all([
        dcGetAll(apiKey, '/leads', {}, 1000, 10, { deadlineMs: 20000, batch: 2, timeoutMs: 15000 }),  // até 10k leads (API não expõe total; truncated marca amostra)
        // /conversations CAPA o count em 999 — não dá pra confiar nele. Paginamos
        // pelos DADOS (ignoreCount) até o fim real, em LOTES DE 3 páginas paralelas
        // (bases grandes: ~3x mais conversas lidas no mesmo tempo), com deadline de 30s
        // + timeout de 12s por página — margem folgada sob o limite de 60s do serverless.
        dcGetAll(apiKey, '/conversations', {}, 300, 50, { ignoreCount: true, deadlineMs: 30000, batch: 3, timeoutMs: 12000 })
      ]);
      cache.set(ck, { at: Date.now(), leadsRes, convsRes });
    }

    // ---- Processamento de leads ----
    // O Grupo VAI usa TAGS como origem real (não o campo source).
    // Por isso agregamos tanto source quanto tags, e também uma origem
    // "EFETIVA": prioriza source, mas usa a primeira tag de origem
    // conhecida quando source está vazio.
    const KNOWN_ORIGIN_TAGS = new Set([
      'Orgânico', 'Meta ADS', 'Google ADS', 'Link Bio',
      'Indicação', 'Indicacao', 'Site', 'WhatsApp', 'Instagram', 'Facebook'
    ]);
    const leadsBySource = {};
    const leadsByTag = {};
    const leadsByEffectiveOrigin = {};
    let leadsWithoutOrigin = 0;

    for (const l of leadsRes.data) {
      // 1) Source bruto
      const src = l.source || 'Sem origem';
      leadsBySource[src] = (leadsBySource[src] || 0) + 1;

      // 2) Tags (todas)
      const tags = Array.isArray(l.tags) ? l.tags.map(t => t.name) : [];
      for (const tName of tags) {
        if (tName) leadsByTag[tName] = (leadsByTag[tName] || 0) + 1;
      }

      // 3) Origem EFETIVA (combinação inteligente)
      let effective = l.source;
      if (!effective) {
        const origTag = tags.find(t => KNOWN_ORIGIN_TAGS.has(t));
        effective = origTag || null;
      }
      if (effective) {
        leadsByEffectiveOrigin[effective] = (leadsByEffectiveOrigin[effective] || 0) + 1;
      } else {
        leadsWithoutOrigin++;
      }
    }
    if (leadsWithoutOrigin > 0) {
      leadsByEffectiveOrigin['Sem origem identificada'] = leadsWithoutOrigin;
    }

    // ---- Conversas COBRÁVEIS = só instâncias OFICIAIS (API Oficial Meta/Cloud) ----
    // Só a API Oficial é cobrada pela Meta; Evolution/Baileys NÃO têm custo Meta.
    // Default: detecta automaticamente pelo provider/engine de CADA conversa.
    // Override manual: se o cliente enviar ?officialInstances=id1,id2, usa esses ids.
    const officialInstancesRaw = q.officialInstances || '';
    const manualOfficialIds = officialInstancesRaw
      ? new Set(officialInstancesRaw.split(',').map(s => s.trim()).filter(Boolean))
      : null;

    const isBillableConv = (c) => manualOfficialIds
      ? !!(c.instance?.id && manualOfficialIds.has(c.instance.id))
      : isOfficialInstance(c.instance);

    const filteredConvs = convsRes.data.filter(isBillableConv);

    // Ids das instâncias oficiais efetivamente encontradas (p/ exibir no rodapé)
    const officialIdsSeen = Array.from(new Set(
      filteredConvs.map(c => c.instance?.id).filter(Boolean)
    ));

    // ---- Processamento de conversas por mês (últimos 12 meses) ----
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = d.toISOString().slice(0, 7);
      months.push({
        month: ym,
        label: d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
        billable: 0,
        total: 0
      });
    }
    const monthMap = Object.fromEntries(months.map(m => [m.month, m]));

    // total = conversas CRIADAS no mês; billable = conversas com ENVIO no mês
    // (pela data do último envio). Antes billable exigia "criada no mês": disparo
    // pra conversa antiga reativava a janela (a Meta cobra) mas sumia da conta.
    // Também conta falhas: statuses com 'error' e criadas no mês sem nenhum envio.
    let errorConversations = 0;
    let createdNoSendThisMonth = 0;
    const nowYm = now.toISOString().slice(0, 7);
    for (const c of filteredConvs) {
      const st = Array.isArray(c.statuses) ? c.statuses : [];
      if (st.includes('error')) errorConversations++;
      if (c.createdAt) {
        const ym = c.createdAt.slice(0, 7);
        const bucket = monthMap[ym];
        if (bucket) bucket.total++;
        if (ym === nowYm && !c.lastSendedMessageDate) createdNoSendThisMonth++;
      }
      if (c.lastSendedMessageDate) {
        const ymS = c.lastSendedMessageDate.slice(0, 7);
        const bucketS = monthMap[ymS];
        if (bucketS) bucketS.billable++;
      }
    }

    // ---- Calcula custo estimado por mês ----
    for (const m of months) {
      m.costUSD = m.billable * avgCostUSD;
      m.costBRL = m.costUSD * usdBrl;
    }

    // ---- KPIs do mês atual + projeção ----
    const thisMonth = months[months.length - 1];
    const lastMonth = months[months.length - 2];

    // Projeção: extrapola o ritmo atual até o fim do mês
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projectionFactor = daysInMonth / Math.max(dayOfMonth, 1);

    const projection = {
      billable: Math.round(thisMonth.billable * projectionFactor),
      costUSD: thisMonth.costUSD * projectionFactor,
      costBRL: thisMonth.costBRL * projectionFactor
    };

    // Total dos últimos 12 meses
    const total12mo = months.reduce((acc, m) => ({
      billable: acc.billable + m.billable,
      total: acc.total + m.total,
      costUSD: acc.costUSD + m.costUSD,
      costBRL: acc.costBRL + m.costBRL
    }), { billable: 0, total: 0, costUSD: 0, costBRL: 0 });

    send(res, 200, {
      kpis: {
        totalLeads: leadsRes.count,
        totalLeadsTruncated: !!leadsRes.truncated,    // true = amostra (base maior que as páginas lidas)
        totalConversations: convsRes.data.length,     // REAL (paginado; ignora o teto de 999 da API)
        conversationsTruncated: !!convsRes.truncated, // true = parou por limite, total pode ser maior
        billableConversations: filteredConvs.length,  // conversas em instâncias OFICIAIS (cobráveis)
        errorConversations,                           // conversas oficiais com status de ERRO de envio
        thisMonth: {
          billable: thisMonth.billable,
          costBRL: thisMonth.costBRL,
          costUSD: thisMonth.costUSD,
          createdWithoutSend: createdNoSendThisMonth, // criadas no mês sem NENHUM envio (falha de disparo)
          projection
        },
        lastMonth: {
          billable: lastMonth?.billable || 0,
          costBRL: lastMonth?.costBRL || 0,
          costUSD: lastMonth?.costUSD || 0
        },
        last12months: total12mo
      },
      monthlySeries: months,
      leadsBySource: Object.entries(leadsBySource)
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count),
      // Retorna TODAS as tags (sem corte) — necessário para o filtro
      // do Simulador de Disparo aceitar tags customizadas (Kommo, etc.)
      leadsByTag: Object.entries(leadsByTag)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count),
      leadsByEffectiveOrigin: Object.entries(leadsByEffectiveOrigin)
        .map(([origin, count]) => ({ origin, count }))
        .sort((a, b) => b.count - a.count),
      config: {
        mix,
        usdBrl,
        avgCostUSD,
        avgCostBRL: avgCostUSD * usdBrl,
        rates: RATES,
        // Info do filtro de instâncias (auto-detecção por provider, ou override manual)
        instanceFilter: {
          active:                  true,
          mode:                    manualOfficialIds ? 'manual' : 'auto',
          officialIds:             manualOfficialIds ? Array.from(manualOfficialIds) : officialIdsSeen,
          conversationsConsidered: filteredConvs.length,
          conversationsTotal:      convsRes.data.length,
          excludedCount:           convsRes.data.length - filteredConvs.length,
          truncated:               !!convsRes.truncated,
          note: manualOfficialIds
            ? 'Custo calculado só das instâncias que você marcou como oficiais.'
            : 'Custo automático: só instâncias OFICIAIS (API Oficial Meta/Cloud). Evolution/Baileys não são cobradas pela Meta.'
        }
      },
      cached: fromCache,
      cacheAgeMs: fromCache ? (Date.now() - cached.at) : 0,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    sendError(res, err);
  }
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

module.exports.config = { maxDuration: 60 };   // redundante com vercel.json, mas explícito
