// ============================================================
// GET /api/kommo/bi-data
// Endpoint mestre do BI rodando sobre o KOMMO. Devolve EXATAMENTE o mesmo
// shape do /api/datacrazy/bi-data, pra o front (index.html) renderizar sem mudar nada.
//
// De-para Kommo -> DataHub:
//   lead.id            -> id / leadId / code
//   lead.created_at    -> createdAt        (unix -> ISO)
//   lead.updated_at    -> lastMovedAt e statusChangedAt (Kommo NÃO expõe a data exata
//                         da mudança de status; aproximamos por updated_at)
//   lead.status_id     -> stageId   (142 = ganho, 143 = perdido — status de sistema do Kommo)
//   lead.pipeline_id   -> pipelineId
//   lead.price         -> total
//   responsible_user_id-> attendantId  (nome via /users)
//   _embedded.tags[]   -> leadTags[]
//   status normalizado -> 'won' (142) | 'lost' (143) | 'in_process'
//
// Carga: pagina TODOS os leads no servidor e devolve em 1 resposta (hasMore:false).
// Cabe com folga até ~12k leads sob o limite do Vercel. Acima disso, paginar por chunk (v2).
// ============================================================

const { getConfig, kGet, kGetAll, send, sendError, handleOptions } = require('./_client');

const STAGE_WON = 142, STAGE_LOST = 143;   // status de sistema do Kommo (em todo funil)
const iso = (u) => (u ? new Date(u * 1000).toISOString() : null);

function normalizeLead(l, stageMap, userMap, sellerSet) {
  const st = stageMap[l.status_id] || {};
  const status = l.status_id === STAGE_WON ? 'won' : (l.status_id === STAGE_LOST ? 'lost' : 'in_process');
  const tags = ((l._embedded && l._embedded.tags) || []).map(t => t.name).filter(Boolean);
  // Vendedor: por padrão o usuário responsável do Kommo. Mas se houver "tags de vendedor"
  // configuradas (cliente que separa vendedor por TAG, não por usuário), o vendedor vem da TAG
  // — e segue o lead mesmo quando o usuário muda (ex.: SDR transfere, mas a tag permanece).
  let attendantId = l.responsible_user_id || null;
  let attendantName = userMap[l.responsible_user_id] || 'Sem vendedor';
  if (sellerSet && sellerSet.size) {
    const hit = tags.find(t => sellerSet.has(t.toLowerCase()));
    if (hit) { attendantId = 'tag:' + hit.toLowerCase(); attendantName = hit; }
    else { attendantId = null; attendantName = 'Sem vendedor'; }   // modo tag: sem tag de vendedor = sem vendedor
  }
  return {
    id: l.id,
    code: l.id,
    createdAt: iso(l.created_at),
    lastMovedAt: iso(l.updated_at),
    statusChangedAt: iso(l.updated_at),   // aproximação (Kommo não dá a data da mudança de etapa)
    stageId: l.status_id,
    stageName: st.name || 'Sem etapa',
    stageColor: st.color || '#94a3b8',
    stageIndex: (st.index != null) ? st.index : 999,
    pipelineId: l.pipeline_id,
    attendantId: attendantId,
    attendantName: attendantName,
    leadId: l.id,
    leadName: l.name || '',
    leadPhone: '',                 // telefone vive no CONTATO (custom field) — fica pra v2
    leadSource: '',
    leadTags: tags,
    total: l.price || 0,
    status,
    lossReasonId: (l.loss_reason_id != null) ? l.loss_reason_id : null,
    productsCount: 0,
    products: []
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);
  try {
    // Este endpoint não passa pelo kill switch do Supabase: a autorização é a
    // POSSE do token do Kommo. Exigimos que ele venha do CLIENTE (header) —
    // com o fallback de env, um GET anônimo baixava a base inteira do tenant.
    const h = req.headers || {};
    if (!(h['x-kommo-token'] || h['X-Kommo-Token']) || !(h['x-kommo-subdomain'] || h['X-Kommo-Subdomain'])) {
      return send(res, 401, {
        error: true, code: 'NO_KOMMO_CONFIG',
        message: 'Credencial do Kommo ausente. Conecte a conta na Central Comercial.'
      });
    }
    const cfg = getConfig(req);
    // "Tags de vendedor": cliente que separa vendedor por TAG (não por usuário). CSV via ?sellerTags= ou env.
    let sellerTagsRaw = process.env.KOMMO_SELLER_TAGS || '';
    try { const _u = new URL(req.url, 'http://x'); const _q = _u.searchParams.get('sellerTags'); if (_q) sellerTagsRaw = _q; } catch (e) {}
    const sellerSet = new Set(String(sellerTagsRaw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

    // 1) Funis + etapas (statuses)
    const pl = await kGet(cfg, '/leads/pipelines');
    const pipelines = (pl._embedded && pl._embedded.pipelines) || [];
    const stageMap = {};
    const pipeOut = pipelines.map(p => {
      const sts = (((p._embedded && p._embedded.statuses) || []).slice()).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      sts.forEach((s, i) => { stageMap[s.id] = { name: s.name, color: s.color, index: (s.sort != null ? s.sort : i), pipelineId: p.id }; });
      return {
        id: p.id, name: p.name, description: '', group: p.is_main ? 'Principal' : '',
        stagesCount: sts.length,
        stages: sts.map((s, i) => ({ id: s.id, name: s.name, color: s.color, index: (s.sort != null ? s.sort : i) }))
      };
    });

    // 2) Usuários (vendedores)
    const users = await kGetAll(cfg, '/users', 'users');
    const userMap = {}; users.forEach(u => { userMap[u.id] = u.name; });

    // 3) Leads (todos) -> normalizados
    const leadsRaw = await kGetAll(cfg, '/leads', 'leads');
    const deals = leadsRaw.map(l => normalizeLead(l, stageMap, userMap, sellerSet));

    return send(res, 200, {
      deals,
      dealsSkip: 0,
      dealsReturned: deals.length,
      dealsTotal: deals.length,
      hasMore: false,
      counts: { deals: deals.length, pipelines: pipeOut.length, attendants: users.length, lossReasons: 0 },
      pipelines: pipeOut,
      attendants: users.map(u => ({ id: u.id, userId: u.id, name: u.name, email: u.email || '', phone: '', image: '' })),
      lossReasons: [],   // Kommo: motivos de perda ficam pra v2
      fetchedAt: new Date().toISOString(),
      source: 'kommo',
      cached: false
    });
  } catch (err) {
    return sendError(res, err);
  }
};

module.exports.config = { maxDuration: 60 };   // pagina toda a base; pode levar ~10-15s
