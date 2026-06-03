// ============================================================
// GET /api/datacrazy/activities
// Atividades do CRM agrupadas por dia, vendedor e categoria.
// Cada atividade é categorizada automaticamente baseado em
// title/description (palavras-chave: proposta, follow-up,
// reunião, ligação, etc).
// ============================================================

const { dcGetAll, send, sendError, getValidatedKey, handleOptions } = require('./_client');

// Heurística de categorização por palavra-chave no title/description
const ACTIVITY_CATEGORIES = [
  { key: 'proposal',  pattern: /proposta|orçamento|orcamento|cota[çc][ãa]o|pedido/i,                label: 'Proposta',  emoji: '📋' },
  { key: 'meeting',   pattern: /reuni[ãa]o|meeting|encontro|visita|agendad/i,                       label: 'Reunião',   emoji: '🗓️' },
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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    // Limite generoso pra atividades — usuário pode passar ?take=N
    const maxPages = parseInt(req.query.maxPages, 10) || 15;
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
      data: normalized,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    sendError(res, err);
  }
};
