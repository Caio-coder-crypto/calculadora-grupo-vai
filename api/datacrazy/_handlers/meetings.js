// ============================================================
// GET /api/datacrazy/meetings
// Mapa de REUNIÕES a partir de CAMPOS ADICIONAIS do LEAD.
//
// Contexto: a API do DataCrazy não expõe o histórico de movimentação de
// etapas, então "quantas reuniões aconteceram no mês" não dá pra derivar
// dos deals. A solução operacional (Grupo VAI/clientes) é registrar a
// reunião em campos adicionais obrigatórios de saída de etapa:
//   - "Data de reunião" / "Data do agendamento"  (date)
//   - "Status da reunião"                        (Realizada | No show)
//   - "Status no show"                           (REAGENDADO | CANCELADO)
//   - "Data do reagendamento"                    (date)
// Este endpoint pagina /leads com complete[additionalFields]=true (único
// jeito de ler os valores EM MASSA) e devolve só o mapa enxuto de quem
// tem algo preenchido — payload pequeno, pro front cruzar com os deals.
//
// Detecção por NOME de campo (regex), pra funcionar em qualquer tenant
// que siga a convenção de nomes.
// ============================================================

const { dcGetAll, send, sendError, getValidatedKey, handleOptions } = require('../_client');

const FIELD_PATTERNS = {
  meetingDate:    /^data\s*(de\s+|da\s+|do\s+)?(reuni|agendamento)/i,
  meetingStatus:  /^status\s*(da\s+|de\s+)?reuni/i,
  noShowStatus:   /^status\s*(do\s+|de\s+)?no[\s-]*show/i,
  rescheduleDate: /^data\s*(do\s+|de\s+)?reagendamento/i
};

// Cache 60s por chave (mesmo padrão do summary)
const CACHE_TTL_MS = 60_000;
if (!globalThis.__dcMeetingsCache) globalThis.__dcMeetingsCache = new Map();
const cache = globalThis.__dcMeetingsCache;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);
  try {
    const apiKey = await getValidatedKey(req);
    const ck = apiKey ? apiKey.slice(-16) : 'anon';
    const force = (req.query || {}).force === '1';

    const cached = cache.get(ck);
    if (!force && cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
      return send(res, 200, { ...cached.payload, cached: true });
    }

    // Pagina leads com os valores dos campos adicionais expandidos.
    // Lotes de 3 + deadline: mesma estratégia anti-timeout do summary.
    const leadsRes = await dcGetAll(
      apiKey, '/leads', { 'complete[additionalFields]': 'true' },
      500, 20, { ignoreCount: true, deadlineMs: 30000, batch: 3, timeoutMs: 12000 }
    );

    const meetings = [];
    const fieldNamesSeen = new Set();
    for (const l of leadsRes.data) {
      const af = Array.isArray(l.additionalFields) ? l.additionalFields : [];
      if (!af.length) continue;
      const m = { leadId: l.id, leadName: l.name || '' };
      let has = false;
      for (const f of af) {
        const name = (f.additionalField && f.additionalField.name) || '';
        const val = f.valueDate || f.value;
        if (!name || val == null || val === '') continue;
        if (FIELD_PATTERNS.rescheduleDate.test(name)) { m.rescheduleDate = f.valueDate || f.value; has = true; fieldNamesSeen.add(name); }
        else if (FIELD_PATTERNS.meetingDate.test(name)) { if (!m.meetingDate) { m.meetingDate = f.valueDate || f.value; has = true; } fieldNamesSeen.add(name); }
        else if (FIELD_PATTERNS.noShowStatus.test(name)) { m.noShowStatus = String(f.value || '').trim(); has = true; fieldNamesSeen.add(name); }
        else if (FIELD_PATTERNS.meetingStatus.test(name)) { m.meetingStatus = String(f.value || '').trim(); has = true; fieldNamesSeen.add(name); }
      }
      if (has) meetings.push(m);
    }

    const payload = {
      meetings,
      counts: { meetings: meetings.length, leadsScanned: leadsRes.data.length },
      truncated: !!leadsRes.truncated,
      fieldsDetected: Array.from(fieldNamesSeen),
      fetchedAt: new Date().toISOString(),
      cached: false
    };
    cache.set(ck, { at: Date.now(), payload });
    return send(res, 200, payload);
  } catch (err) {
    sendError(res, err);
  }
};

module.exports.config = { maxDuration: 60 };
