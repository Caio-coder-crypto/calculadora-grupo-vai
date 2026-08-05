// ============================================================
// Núcleo do RESUMO DIÁRIO. Usado por:
//   - daily-report.js       (preview sob demanda, via botão no BI)
//   - daily-report-send.js  (cron das 8h, dispara no WhatsApp)
// Um único lugar calcula e formata — preview e disparo nunca divergem.
//
// PRECISÃO:
//   exato       → leads criados, negócios criados, ganhos, perdidos, atividades
//   aproximado  → movimentação por etapa. O DataCrazy NÃO guarda histórico de
//                 estágio (só stageId atual + lastMovedAt), então um negócio que
//                 passou por duas etapas no mesmo dia conta só na última.
//
// Sem classificador de canal aqui de propósito: a classificação vive no front
// (composeChannel/getDealPlatform) e duplicá-la no servidor recriaria o bug de
// "duas engines discordando" corrigido na auditoria de ago/2026. A quebra de
// leads sai por CONTAGEM LITERAL de tag — só filtrando nomes de vendedor, que
// são tag de atendimento e não de origem.
// ============================================================

const { dcGetAll, dcGet } = require('../_client');

const BRT_OFFSET_MS = 3 * 3600000;   // 00:00 BRT = 03:00 UTC (sem horário de verão desde 2019)
const PAGE = 1000;

function brtDayRange(dateStr) {
  let y, m, d;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    [y, m, d] = dateStr.split('-').map(Number);
    m -= 1;
  } else {
    const nowBrt = new Date(Date.now() - BRT_OFFSET_MS);
    const yst = new Date(Date.UTC(nowBrt.getUTCFullYear(), nowBrt.getUTCMonth(), nowBrt.getUTCDate() - 1));
    y = yst.getUTCFullYear(); m = yst.getUTCMonth(); d = yst.getUTCDate();
  }
  const start = Date.UTC(y, m, d, 3, 0, 0, 0);
  return { start, end: start + 86400000, y, m, d };
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
function labelDia(r) {
  const dt = new Date(r.start + 12 * 3600000);
  return `${DIAS[dt.getUTCDay()]}, ${String(r.d).padStart(2, '0')}/${String(r.m + 1).padStart(2, '0')}`;
}

const inRange = (stamp, r) => {
  if (!stamp) return false;
  const t = new Date(stamp).getTime();
  return t >= r.start && t < r.end;
};

const brl = v => 'R$ ' + new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0);
const plural = (n, um, muitos) => `${n} ${n === 1 ? um : muitos}`;

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

// Nomes de vendedor viram tag em vários CRMs (ex.: "CECÍLIA", "RAPHA").
// Elas poluem a quebra de origem — "8 Orgânico · 8 CECÍLIA" não diz nada.
function sellerTagMatcher(attendants) {
  const names = new Set();
  for (const a of attendants) {
    const full = (a.name || '').trim().toLowerCase();
    if (!full) continue;
    names.add(full);
    const first = full.split(/\s+/)[0];
    if (first.length >= 3) names.add(first);
  }
  return tag => names.has((tag || '').trim().toLowerCase());
}

async function buildDailyReport(apiKey, opts = {}) {
  const range = brtDayRange(opts.date);
  const pipelineFilter = opts.pipelineId || null;

  const [businesses, leads, activitiesRes, lossReasonsRes, attendantsRes] = await Promise.all([
    fetchAll(apiKey, '/businesses', 30),
    fetchAll(apiKey, '/leads', 30),
    dcGetAll(apiKey, '/activities', {}, 200, 15),
    dcGetAll(apiKey, '/business-loss-reasons', {}, 100, 2),
    dcGetAll(apiKey, '/attendants/crm', {}, 100, 3)
  ]);

  const lossReasonName = {};
  for (const lr of (lossReasonsRes.data || [])) lossReasonName[lr.id] = lr.name;
  const isSellerTag = sellerTagMatcher(attendantsRes.data || []);

  const pipeOf = b => b.stage?.pipeline?.id || null;
  const inScope = b => !pipelineFilter || pipeOf(b) === pipelineFilter;

  // ---- LEADS criados no dia (exato) ----
  const leadsDay = leads.filter(l => inRange(l.createdAt, range));
  const tagCount = {};
  for (const l of leadsDay) {
    for (const t of (l.tags || [])) {
      const n = t?.name;
      if (n && !isSellerTag(n)) tagCount[n] = (tagCount[n] || 0) + 1;
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
  const topLoss = Object.entries(lostBy).sort((a, b) => b[1] - a[1]).slice(0, 3);

  // ---- MOVIMENTAÇÃO por etapa (APROXIMADO) ----
  const movedByStage = {};
  let movedTotal = 0;
  for (const b of businesses) {
    if (!inScope(b) || isWon(b) || isLost(b)) continue;
    if (!inRange(b.lastMovedAt, range)) continue;
    const n = b.stage?.name || 'Sem etapa';
    movedByStage[n] = (movedByStage[n] || 0) + 1;
    movedTotal++;
  }
  const movedSorted = Object.entries(movedByStage).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

  // ---- ATIVIDADES do dia (exato) ----
  const actsDay = (activitiesRes.data || []).filter(a => inRange(a.createdAt, range));
  const byType = {};
  for (const a of actsDay) {
    const n = a.activityType?.name || a.type?.name || a.title || 'Outras';
    byType[n] = (byType[n] || 0) + 1;
  }
  const actsSorted = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6);

  // ---- EM ABERTO (foto do momento, não do dia) ----
  const open = businesses.filter(b => inScope(b) && !isWon(b) && !isLost(b));
  const openValue = open.reduce((s, b) => s + (b.total || 0), 0);

  // ---- Mensagem ----
  const L = [];
  L.push(`📊 *RESUMO DO DIA — ${labelDia(range)}*`);
  L.push('');
  L.push('🌱 *CHEGARAM*');
  L.push(plural(leadsDay.length, 'lead novo', 'leads novos'));
  if (topTags.length) L.push('   ' + topTags.map(([n, c]) => `${c} ${n}`).join(' · '));
  L.push('');
  L.push('⚡ *MOVIMENTO*');
  L.push(plural(dealsCreated.length, 'negócio aberto', 'negócios abertos'));
  if (movedTotal) {
    L.push(`${plural(movedTotal, 'negócio mudou', 'negócios mudaram')} de etapa:`);
    for (const [n, c] of movedSorted.slice(0, 6)) L.push(`   ${c} → ${n}`);
  } else {
    L.push('nenhuma mudança de etapa registrada');
  }
  if (actsSorted.length) {
    L.push('');
    L.push('✅ *ATIVIDADES*');
    for (const [n, c] of actsSorted) L.push(`   ${c} ${n}`);
  }
  L.push('');
  L.push('💰 *FECHAMENTO*');
  L.push(won.length ? `🟢 ${plural(won.length, 'venda ganha', 'vendas ganhas')} — ${brl(wonValue)}`
                    : '🟢 nenhuma venda fechada');
  if (lost.length) {
    L.push(`🔴 ${plural(lost.length, 'perdida', 'perdidas')} — ${brl(lostValue)}`);
    for (const [n, c] of topLoss) L.push(`   ${c}× ${n}`);
  }
  L.push('');
  L.push('📌 *NA MESA AGORA*');
  L.push(`${open.length} negócios em aberto — ${brl(openValue)}`);

  return {
    date: `${range.y}-${String(range.m + 1).padStart(2, '0')}-${String(range.d).padStart(2, '0')}`,
    label: labelDia(range),
    text: L.join('\n'),
    data: {
      leadsCreated: leadsDay.length,
      leadsByTag: Object.fromEntries(topTags),
      dealsCreated: dealsCreated.length,
      movedTotal, movedByStage,
      activitiesByType: Object.fromEntries(actsSorted),
      won: won.length, wonValue,
      lost: lost.length, lostValue,
      openCount: open.length, openValue
    },
    precision: {
      exact: ['leadsCreated', 'dealsCreated', 'won', 'lost', 'activitiesByType'],
      approximate: ['movedByStage'],
      note: 'A movimentação por etapa subconta: o CRM não guarda histórico de estágio, só o atual + lastMovedAt. Negócio que passou por duas etapas no mesmo dia aparece só na última.'
    },
    scanned: { businesses: businesses.length, leads: leads.length, activities: (activitiesRes.data || []).length }
  };
}

module.exports = { buildDailyReport, brtDayRange, labelDia };
