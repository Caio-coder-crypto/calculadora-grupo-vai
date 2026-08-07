// ============================================================
// GET /api/datacrazy/activities
// Atividades do CRM agrupadas por dia, vendedor e categoria.
// Cada atividade é categorizada automaticamente baseado em
// title/description (palavras-chave: proposta, follow-up,
// reunião, ligação, etc).
// ============================================================

const { dcGetAll, send, sendError, getValidatedKey, handleOptions } = require('../_client');

// Heurística de categorização por palavra-chave no title/description
const ACTIVITY_CATEGORIES = [
  { key: 'proposal',  pattern: /proposta|orçamento|orcamento|cota[çc][ãa]o|pedido/i,                label: 'Proposta',  emoji: '📋' },
  { key: 'meeting',   pattern: /reuni[ãa]o|meeting|encontro|visita|agendad|marcad|remarcad/i,         label: 'Reunião',   emoji: '🗓️' },
  { key: 'followup',  pattern: /follow|follow-?up|retorno|cobrar|aguardando|insistir|tentar de novo/i, label: 'Follow-up', emoji: '🔄' },
  { key: 'call',      pattern: /liga[çc][ãa]o|telefone|chamada|call|telefonar/i,                    label: 'Ligação',   emoji: '📞' },
  { key: 'message',   pattern: /mensagem|whats|whatsapp|enviar|responder/i,                         label: 'Mensagem',  emoji: '💬' },
  { key: 'delivery',  pattern: /entreg|entregar|envio|enviar.*produto/i,                            label: 'Entrega',   emoji: '📦' },
];

function categorize(activity) {
  const text = ((activity.title || '') + ' ' + (activity.description || '')).toLowerCase();
  for (const cat of ACTIVITY_CATEGORIES) {
    if (cat.pattern.test(text)) return cat.key;
  }
  return 'other';
}

// Item 5 — separação fina de reuniões + detecção de 1º contato (palavras-chave)
const MEETING_SCHEDULED = /agendad|marcad|remarcad|agendar/i;
const MEETING_HELD      = /realizad|feit[ao]|conclu[íi]d|aconteceu|compareceu|ocorreu/i;
const FIRST_CONTACT     = /liga[çc][ãa]o|contato|mensagem|whats|atend|abordagem|primeiro contato/i;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    // Limite generoso pra atividades — usuário pode passar ?take=N
    // Clamp: sem teto, ?maxPages=100000 encadeava chamadas ao upstream até o
    // timeout da função (amplificação barata, já que não há rate limit).
    const maxPages = Math.min(50, Math.max(1, parseInt(req.query.maxPages, 10) || 15));
    const { count, data } = await dcGetAll(apiKey, '/activities', {}, 200, maxPages);

    // Normaliza e categoriza
    const normalized = data.map(a => {
      const category = categorize(a);
      const lead = a.lead || null;
      // Atendente pode vir de a.assignedTo, ou do lead.attendant
      const attendantId   = a.assignedToId || a.assigned?.id || lead?.attendant?.id || null;
      const attendantName = a.assignedTo?.name || a.assigned?.name || lead?.attendant?.name || null;
      return {
        id:           a.id,
        createdAt:    a.createdAt,
        startDate:    a.startDate,
        endDate:      a.endDate,
        title:        a.title,
        description:  (a.description || '').slice(0, 200),
        isCompleted:  !!a.isCompleted,
        category,
        attendantId,
        attendantName,
        leadId:       lead?.id || null,
        leadName:     lead?.name || null,
        businessId:   a.business?.id || null
      };
    });

    // Agrupa por categoria (totais gerais)
    const byCategory = {};
    for (const a of normalized) {
      byCategory[a.category] = (byCategory[a.category] || 0) + 1;
    }

    // Agrupa por DIA (últimos 30 dias)
    const byDay = {};
    for (const a of normalized) {
      if (!a.createdAt) continue;
      const day = a.createdAt.slice(0, 10);  // YYYY-MM-DD
      if (!byDay[day]) byDay[day] = { day, total: 0, byCategory: {} };
      byDay[day].total++;
      byDay[day].byCategory[a.category] = (byDay[day].byCategory[a.category] || 0) + 1;
    }

    // ===== Item 5 — métricas de gestão por vendedor =====
    // - leadsContacted: nº de LEADS distintos que receberam pelo menos 1 atividade de contato
    //   (denominador da Taxa de Atendimento = leadsContacted / leadsRecebidos[att], calculado no front)
    // - meetingsScheduled / meetingsHeld: reuniões agendadas vs efetivamente realizadas
    const byAttendant = {};
    const contactedLeadsByAtt = {}; // attId -> Set(leadId)
    for (const a of normalized) {
      const att = a.attendantId || 'sem_vendedor';
      if (!byAttendant[att]) {
        byAttendant[att] = { attendantId: a.attendantId, attendantName: a.attendantName, meetingsScheduled: 0, meetingsHeld: 0, leadsContacted: 0 };
      }
      const text = ((a.title || '') + ' ' + (a.description || '')).toLowerCase();
      if (a.category === 'meeting') {
        if (MEETING_HELD.test(text) || (a.isCompleted && !MEETING_SCHEDULED.test(text))) byAttendant[att].meetingsHeld++;
        else if (MEETING_SCHEDULED.test(text)) byAttendant[att].meetingsScheduled++;
      }
      if (FIRST_CONTACT.test(text) && a.leadId) {
        (contactedLeadsByAtt[att] = contactedLeadsByAtt[att] || new Set()).add(a.leadId);
      }
    }
    for (const att of Object.keys(byAttendant)) {
      byAttendant[att].leadsContacted = contactedLeadsByAtt[att] ? contactedLeadsByAtt[att].size : 0;
    }

    send(res, 200, {
      total: count,
      sampled: normalized.length,
      categories: ACTIVITY_CATEGORIES.map(c => ({
        key:   c.key,
        label: c.label,
        emoji: c.emoji,
        count: byCategory[c.key] || 0
      })),
      byDay: Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day)),
      byAttendant: Object.values(byAttendant),  // Item 5
      data: normalized,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    sendError(res, err);
  }
};
