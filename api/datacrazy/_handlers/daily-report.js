// ============================================================
// GET /api/datacrazy/daily-report
// Resumo diário do CRM em texto pronto pra WhatsApp.
//
// Query params:
//   - date  (YYYY-MM-DD) dia alvo. Default = ONTEM em horário de Brasília.
//   - pipelineId (opcional) restringe o movimento de funil a um pipeline.
//
// Retorna { date, text, data } — `text` é a mensagem formatada.
// NÃO ENVIA NADA. O disparo é um passo separado e explícito.
//
// PRECISÃO — leia antes de confiar em cada número:
//   exato        → leads criados, negócios criados, ganhos, perdidos, atividades
//   aproximado   → "movimentação por etapa". O DataCrazy NÃO guarda histórico de
//                  estágio: cada negócio tem só o stageId ATUAL e um lastMovedAt.
//                  Então "entrou em Qualificação ontem" é lido como "está em
//                  Qualificação E se moveu ontem". Um negócio que passou por
//                  Qualificação e foi pra Reunião no mesmo dia só aparece em
//                  Reunião — subconta. Pra virar exato precisa de snapshot diário
//                  com storage (fase 2).
//
// Sem classificador de canal aqui de propósito: a classificação vive no front
// (composeChannel/getDealPlatform) e duplicá-la no servidor recriaria o bug de
// "duas engines discordando" que a auditoria de ago/2026 corrigiu. A quebra de
// leads sai por CONTAGEM LITERAL de tag, sem interpretação.
// ============================================================

const { dcGetAll, dcGet, send, sendError, getValidatedKey, handleOptions } = require('../_client');

const BRT_OFFSET_MS = 3 * 3600000;   // 00:00 BRT = 03:00 UTC (sem horário de verão desde 2019)
const PAGE = 1000;

// Janela [início, fim) do dia alvo em BRT, retornada em timestamps UTC.
function brtDayRange(dateStr) {
  let y, m, d;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    [y, m, d] = dateStr.split('-').map(Number);
    m -= 1;
  } else {
    // Default: ONTEM em BRT
    const nowBrt = new Date(Date.now() - BRT_OFFSET_MS);
    const y2 = nowBrt.getUTCFullYear(), m2 = nowBrt.getUTCMonth(), d2 = nowBrt.getUTCDate();
    const yesterday = new Date(Date.UTC(y2, m2, d2 - 1));
    y = yesterday.getUTCFullYear(); m = yesterday.getUTCMonth(); d = yesterday.getUTCDate();
  }
  const start = Date.UTC(y, m, d, 3, 0, 0, 0);
  return { start, end: start + 86400000, y, m, d };
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
function labelDia(range) {
  const dt = new Date(range.start + 12 * 3600000);   // meio-dia, longe de qualquer borda
  const dd = String(range.d).padStart(2, '0');
  const mm = String(range.m + 1).padStart(2, '0');
  return `${DIAS[dt.getUTCDay()]}, ${dd}/${mm}`;
}

const inRange = (stamp, r) => {
  if (!stamp) return false;
  const t = new Date(stamp).getTime();
  return t >= r.start && t < r.end;
};

const brl = (v) => 'R$ ' + new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0);

// Puxa todas as páginas de um recurso (a API do DataCrazy ignora filtros de data).
async function fetchAll(apiKey, path, maxPages) {
  const first = await dcGet(apiKey, path, { skip: 0, take: PAGE });
  const total = first.count ?? (first.data || []).length;
  const out = [...(first.data || [])];
  const pages = Math.min(Math.ceil(total / PAGE), maxPages);
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) => dcGet(apiKey, path, { skip: (i + 1) * PAGE, take: PAGE }))
    );
    for (const r of rest) out.push(...(r.data || []));
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const range = brtDayRange(req.query.date);
    const pipelineFilter = req.query.pipelineId || null;

    const [businesses, leads, activitiesRes, lossReasonsRes] = await Promise.all([
      fetchAll(apiKey, '/businesses', 30),
      fetchAll(apiKey, '/leads', 30),
      dcGetAll(apiKey, '/activities', {}, 200, 15),
      dcGetAll(apiKey, '/business-loss-reasons', {}, 100, 2)
    ]);

    const lossReasonName = {};
    for (const lr of (lossReasonsRes.data || [])) lossReasonName[lr.id] = lr.name;

    const pipeOf = b => b.stage?.pipeline?.id || null;
    const inScope = b => !pipelineFilter || pipeOf(b) === pipelineFilter;

    // ---- LEADS criados no dia (exato) ----
    const leadsDay = leads.filter(l => inRange(l.createdAt, range));
    const tagCount = {};
    for (const l of leadsDay) {
      for (const t of (l.tags || [])) {
        const n = t?.name;
        if (n) tagCount[n] = (tagCount[n] || 0) + 1;
      }
    }
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

    // ---- NEGÓCIOS criados no dia (exato) ----
    const dealsCreated = businesses.filter(b => inScope(b) && inRange(b.createdAt, range));

    // ---- GANHOS / PERDIDOS no dia (exato, por statusChangedAt) ----
    const stamp = b => b.statusChangedAt || b.lastMovedAt || b.createdAt;
    const isWon  = b => b.status === 'WON'  || b.status === 'won';
    const isLost = b => b.status === 'LOST' || b.status === 'lost';
    const won  = businesses.filter(b => inScope(b) && isWon(b)  && inRange(stamp(b), range));
    const lost = businesses.filter(b => inScope(b) && isLost(b) && inRange(stamp(b), range));
    const wonValue  = won.reduce((s, b) => s + (b.total || 0), 0);
    const lostValue = lost.reduce((s, b) => s + (b.total || 0), 0);
    const lostBy = {};
    for (const b of lost) {
      const n = lossReasonName[b.lossReasonId] || 'sem motivo informado';
      lostBy[n] = (lostBy[n] || 0) + 1;
    }
    const topLoss = Object.entries(lostBy).sort((a, b) => b[1] - a[1]).slice(0, 2);

    // ---- MOVIMENTAÇÃO por etapa (APROXIMADO — ver cabeçalho) ----
    const movedByStage = {};
    for (const b of businesses) {
      if (!inScope(b) || isWon(b) || isLost(b)) continue;
      if (!inRange(b.lastMovedAt, range)) continue;
      const n = b.stage?.name || 'Sem etapa';
      movedByStage[n] = (movedByStage[n] || 0) + 1;
    }
    const movedSorted = Object.entries(movedByStage)
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

    // ---- ATIVIDADES do dia (exato) — usa o TIPO cadastrado no CRM ----
    const actsDay = (activitiesRes.data || []).filter(a => inRange(a.createdAt, range));
    const byType = {};
    for (const a of actsDay) {
      const n = a.activityType?.name || a.type?.name || a.title || 'Outras';
      byType[n] = (byType[n] || 0) + 1;
    }
    const actsSorted = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6);

    // ---- PIPELINE EM ABERTO (foto do momento, não do dia) ----
    const open = businesses.filter(b => inScope(b) && !isWon(b) && !isLost(b));
    const openValue = open.reduce((s, b) => s + (b.total || 0), 0);

    // ---- Monta a mensagem ----
    const L = [];
    L.push(`📊 *RESUMO DO DIA — ${labelDia(range)}*`);
    L.push('');
    L.push(`🌱 *CHEGARAM*`);
    L.push(`${leadsDay.length} ${leadsDay.length === 1 ? 'lead novo' : 'leads novos'}`);
    if (topTags.length) L.push('   ' + topTags.map(([n, c]) => `${c} ${n}`).join(' · '));
    L.push('');
    L.push(`⚡ *MOVIMENTO*`);
    L.push(`${dealsCreated.length} ${dealsCreated.length === 1 ? 'negócio aberto' : 'negócios abertos'}`);
    if (movedSorted.length) {
      for (const [n, c] of movedSorted.slice(0, 6)) L.push(`   ${c} → ${n}`);
    } else {
      L.push('   sem movimentação de etapa registrada');
    }
    if (actsSorted.length) {
      L.push('');
      L.push(`✅ *ATIVIDADES*`);
      for (const [n, c] of actsSorted) L.push(`   ${c} ${n}`);
    }
    L.push('');
    L.push(`💰 *FECHAMENTO*`);
    if (won.length)  L.push(`🟢 ${won.length} ${won.length === 1 ? 'venda ganha' : 'vendas ganhas'} — ${brl(wonValue)}`);
    else             L.push(`🟢 nenhuma venda fechada`);
    if (lost.length) {
      L.push(`🔴 ${lost.length} ${lost.length === 1 ? 'perdida' : 'perdidas'} — ${brl(lostValue)}`);
      for (const [n, c] of topLoss) L.push(`   ${c}× ${n}`);
    }
    L.push('');
    L.push(`📌 *NA MESA AGORA*`);
    L.push(`${open.length} negócios em aberto — ${brl(openValue)}`);

    const text = L.join('\n');

    send(res, 200, {
      date: `${range.y}-${String(range.m + 1).padStart(2, '0')}-${String(range.d).padStart(2, '0')}`,
      label: labelDia(range),
      text,
      data: {
        leadsCreated: leadsDay.length,
        leadsByTag: Object.fromEntries(topTags),
        dealsCreated: dealsCreated.length,
        movedByStage,
        activitiesByType: Object.fromEntries(actsSorted),
        won: won.length, wonValue,
        lost: lost.length, lostValue,
        openCount: open.length, openValue
      },
      precision: {
        exact: ['leadsCreated', 'dealsCreated', 'won', 'lost', 'activitiesByType'],
        approximate: ['movedByStage'],
        note: 'movedByStage subconta: o CRM não guarda histórico de estágio, só o atual + lastMovedAt. Negócio que passou por duas etapas no mesmo dia aparece só na última.'
      },
      scanned: { businesses: businesses.length, leads: leads.length, activities: (activitiesRes.data || []).length },
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    sendError(res, err);
  }
};
