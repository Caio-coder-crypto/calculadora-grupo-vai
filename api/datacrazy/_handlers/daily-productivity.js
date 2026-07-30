// ============================================================
// GET /api/datacrazy/daily-productivity
// Métricas diárias por vendedor — combinando deals + activities.
//
// Query params:
//   - date (YYYY-MM-DD, opcional, default = hoje)
//   - days (número de dias retroativos, default = 1)
//
// Retorna:
//   - kpis globais do(s) dia(s)
//   - tabela por vendedor com: leads novos, propostas, follow-ups, atendimentos
//   - explicação de como cada métrica é calculada (acaba a divergência)
// ============================================================

const { dcGetAll, send, sendError, getValidatedKey, handleOptions } = require('../_client');

// Cache de 60s (igual aos outros endpoints)
if (!globalThis.__dcProductivityCache) globalThis.__dcProductivityCache = new Map();
const cache = globalThis.__dcProductivityCache;
const CACHE_TTL_MS = 60_000;

const ACTIVITY_PATTERNS = {
  proposal: /proposta|orçamento|orcamento|cota[çc][ãa]o|pedido/i,
  meeting:  /reuni[ãa]o|meeting|encontro|visita|agendad/i,
  followup: /follow|follow-?up|retorno|cobrar|aguardando|insistir/i,
  call:     /liga[çc][ãa]o|telefone|chamada|call|telefonar/i
};

function categorizeActivity(activity) {
  const text = ((activity.title || '') + ' ' + (activity.description || '')).toLowerCase();
  for (const [key, pattern] of Object.entries(ACTIVITY_PATTERNS)) {
    if (pattern.test(text)) return key;
  }
  return 'other';
}

// Item 5 — separação fina de reuniões + detecção de 1º contato
const MEETING_SCHEDULED = /agendad|marcad|remarcad|agendar/i;
const MEETING_HELD      = /realizad|feit[ao]|conclu[íi]d|aconteceu|compareceu|ocorreu/i;
const FIRST_CONTACT     = /liga[çc][ãa]o|contato|mensagem|whats|atend|abordagem|primeiro contato/i;

function inDateRange(timestamp, startTs, endTs) {
  if (!timestamp) return false;
  const t = new Date(timestamp).getTime();
  return t >= startTs && t < endTs;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const q = req.query || {};

    // Calcula janela de tempo
    const targetDate = q.date ? new Date(q.date + 'T00:00:00') : new Date();
    targetDate.setHours(0, 0, 0, 0);
    const daysBack = Math.max(1, Math.min(parseInt(q.days, 10) || 1, 30));

    const endTs   = targetDate.getTime() + 86400000;       // fim do dia alvo
    const startTs = endTs - daysBack * 86400000;            // X dias atrás

    // Cache key
    const ck = (apiKey || 'anon').slice(-12) + ':' + new Date(startTs).toISOString().slice(0, 10) + '_' + daysBack;
    const force = q.force === '1';
    const cached = cache.get(ck);
    if (!force && cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
      return send(res, 200, { ...cached.payload, cached: true, cacheAgeMs: Date.now() - cached.at });
    }

    // Busca paralela: businesses + activities + attendants
    // Limites menores que o BI completo pra não estourar timeout
    const [businessesRes, activitiesRes, attendantsRes] = await Promise.all([
      dcGetAll(apiKey, '/businesses', {}, 200, 15),         // até 3000 deals (recentes vêm primeiro)
      dcGetAll(apiKey, '/activities',  {}, 200, 10),        // até 2000 atividades
      dcGetAll(apiKey, '/attendants/crm', {}, 100, 5)
    ]);

    const attendants     = attendantsRes.data || [];
    const attendantsById = Object.fromEntries(attendants.map(a => [a.id, a]));

    // ---- Indexa por vendedor ----
    const stats = {};  // attendantId → { newLeads, proposals, followups, conversations, ... }
    const ensure = (id, name) => {
      if (!id) return null;
      if (!stats[id]) {
        stats[id] = {
          id, name: name || attendantsById[id]?.name || '?',
          newLeads:      0,  // negócios CRIADOS no período (lead novo)
          proposals:     0,  // movimentos pra etapa "Proposta" no período (estimativa via lastMovedAt + nome da etapa)
          followups:     0,  // atividades de follow-up no período
          meetings:      0,  // atividades de reunião no período
          meetingsScheduled: 0,  // item 5 — reuniões AGENDADAS
          meetingsHeld:      0,  // item 5 — reuniões REALIZADAS
          calls:         0,  // atividades de ligação no período
          conversations: 0,  // deals com lastSendedMessageDate no período (interação enviada)
          leadsReceived:  0, // item 5 — leads recebidos (deals criados no período)
          leadsContacted: 0, // item 5 — desses, quantos tiveram 1º contato
          serviceRate:    0, // item 5 — taxa de atendimento (0..1)
          totalActivities: 0
        };
      }
      return stats[id];
    };

    // ---- Processa BUSINESSES (deals) ----
    const receivedLeads = {};   // item 5: attId -> Set(leadId) recebidos no período
    const contactedLeadsGlobal = new Set();  // item 5: leadId com 1º contato (qualquer vendedor) — evita mismatch de attId entre businesses e activities
    let totalMeetingsScheduled = 0, totalMeetingsHeld = 0;  // item 5
    let totalNewLeads = 0, totalProposals = 0, totalConversations = 0;
    for (const b of businessesRes.data) {
      const attId   = b.attendantId;
      const attName = b.attendant?.name;
      const bucket  = ensure(attId, attName);
      if (!bucket) continue;

      // 1) Lead novo no período (deal criado dentro da janela)
      if (inDateRange(b.createdAt, startTs, endTs)) {
        bucket.newLeads++;
        totalNewLeads++;
        // item 5 — registra o lead como "recebido" pelo vendedor (denominador da taxa de atendimento)
        const lid = b.leadId || b.lead?.id;
        if (lid) (receivedLeads[attId] = receivedLeads[attId] || new Set()).add(lid);
      }

      // 2) Proposta — deal em etapa com "proposta" no nome E movido no período
      const stageName = (b.stage?.name || '').toLowerCase();
      if (ACTIVITY_PATTERNS.proposal.test(stageName) && inDateRange(b.lastMovedAt, startTs, endTs)) {
        bucket.proposals++;
        totalProposals++;
      }

      // 3) Conversação/atendimento — interação enviada no período (via contato do lead)
      const contacts = b.lead?.contacts || [];
      for (const c of contacts) {
        const lastSent = c.lastContactStatus?.lastSendedDate;
        if (inDateRange(lastSent, startTs, endTs)) {
          bucket.conversations++;
          totalConversations++;
          break;  // conta 1x por deal
        }
      }
    }

    // ---- Processa ACTIVITIES ----
    let totalFollowups = 0, totalMeetings = 0, totalCalls = 0;
    for (const a of activitiesRes.data) {
      if (!inDateRange(a.createdAt, startTs, endTs)) continue;
      const cat = categorizeActivity(a);
      const attId   = a.lead?.attendant?.id || a.assignedToId;
      const attName = a.lead?.attendant?.name || a.assignedTo?.name;
      const bucket  = ensure(attId, attName);
      if (!bucket) continue;
      const aText = ((a.title || '') + ' ' + (a.description || '')).toLowerCase();
      const aLeadId = a.lead?.id || a.leadId;
      bucket.totalActivities++;
      if (cat === 'followup') { bucket.followups++; totalFollowups++; }
      else if (cat === 'meeting')  {
        bucket.meetings++;  totalMeetings++;
        // item 5 — reunião agendada vs realizada (palavra-chave + flag isCompleted como desempate)
        if (MEETING_HELD.test(aText) || (a.isCompleted && !MEETING_SCHEDULED.test(aText))) { bucket.meetingsHeld++; totalMeetingsHeld++; }
        else if (MEETING_SCHEDULED.test(aText)) { bucket.meetingsScheduled++; totalMeetingsScheduled++; }
      }
      else if (cat === 'call')     { bucket.calls++;     totalCalls++; }
      else if (cat === 'proposal' && bucket.proposals === 0) {
        // Se já não contamos via stage, conta a atividade como proposta
        bucket.proposals++;
        totalProposals++;
      }
      // item 5 — marca 1º contato do lead (global por leadId; atribuído ao DONO do lead no pós-processo)
      if (aLeadId && (cat === 'call' || FIRST_CONTACT.test(aText))) {
        contactedLeadsGlobal.add(aLeadId);
      }
    }

    // ---- Item 5 — Taxa de Atendimento por vendedor (leads recebidos que foram contatados) ----
    // Atribui o contato ao DONO do lead recebido (business.attendantId), não ao att da atividade →
    // robusto a divergência de attId entre /businesses e /activities.
    let totalReceived = 0, totalContacted = 0;
    for (const id of Object.keys(stats)) {
      const recv = receivedLeads[id] || new Set();
      let contactedAmongReceived = 0;
      for (const lid of recv) if (contactedLeadsGlobal.has(lid)) contactedAmongReceived++;
      stats[id].leadsReceived  = recv.size;
      stats[id].leadsContacted = contactedAmongReceived;
      stats[id].serviceRate    = recv.size > 0 ? +(contactedAmongReceived / recv.size).toFixed(3) : 0;
      totalReceived  += recv.size;
      totalContacted += contactedAmongReceived;
    }

    // ---- Ordena ranking ----
    const ranking = Object.values(stats)
      .sort((a, b) => (b.newLeads + b.proposals + b.followups + b.conversations) -
                      (a.newLeads + a.proposals + a.followups + a.conversations));

    const payload = {
      window: {
        startDate: new Date(startTs).toISOString().slice(0, 10),
        endDate:   new Date(endTs - 1).toISOString().slice(0, 10),
        daysBack,
        targetDate: targetDate.toISOString().slice(0, 10)
      },
      kpis: {
        newLeads:      totalNewLeads,
        proposals:     totalProposals,
        followups:     totalFollowups,
        meetings:      totalMeetings,
        meetingsScheduled: totalMeetingsScheduled,  // item 5
        meetingsHeld:      totalMeetingsHeld,        // item 5
        calls:         totalCalls,
        conversations: totalConversations,
        serviceRate:   totalReceived > 0 ? +(totalContacted / totalReceived).toFixed(3) : 0,  // item 5 (equipe)
        attendantsActive: ranking.filter(r => (r.newLeads + r.proposals + r.followups + r.conversations) > 0).length
      },
      ranking,
      // Explicação de como cada métrica é calculada (transparência total)
      methodology: {
        newLeads:      'Negócios (deals) criados no período. 1 lead = 1 deal novo. Se um lead tem múltiplos deals, conta cada um.',
        proposals:     'Deals atualmente em etapa cujo nome contém "proposta/orçamento/cotação/pedido" E foram movidos no período. + Atividades cujo título contém "proposta".',
        followups:     'Atividades cadastradas no CRM cujo título/descrição contém "follow/retorno/cobrar".',
        meetings:      'Atividades cujo título/descrição contém "reunião/meeting/encontro/visita".',
        calls:         'Atividades cujo título/descrição contém "ligação/telefone/chamada".',
        conversations: 'Deals onde o contato do lead enviou ou recebeu mensagem no WhatsApp/canal no período.',
        serviceRate:   'Taxa de Atendimento = leads recebidos no período (deals criados) que tiveram ao menos 1 atividade de contato (ligação/mensagem/abordagem) ÷ total de leads recebidos.',
        meetingsSplit: 'Reuniões: Realizadas (palavra "realizad/feita/concluída" ou atividade marcada como concluída) vs Agendadas (palavra "agendad/marcad").'
      },
      counts: {
        businessesScanned: businessesRes.data.length,
        activitiesScanned: activitiesRes.data.length,
        totalActivities:   activitiesRes.count,
        totalBusinesses:   businessesRes.count
      },
      fetchedAt: new Date().toISOString()
    };

    cache.set(ck, { at: Date.now(), payload });
    send(res, 200, { ...payload, cached: false });
  } catch (err) {
    sendError(res, err);
  }
};
