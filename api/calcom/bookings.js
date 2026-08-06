// ============================================================
// GET /api/calcom/bookings
// Proxy normalizado da API v2 do Cal.com pra aba Reuniões do BI.
//
// A chave do Cal.com vem do NAVEGADOR do cliente (header X-CalCom-Key,
// guardada no localStorage dele) — nunca fica no servidor, igual ao
// padrão multi-tenant do X-DataCrazy-Key.
//
// Fontes se complementam: Cal.com é a AGENDA (agendadas/canceladas/
// reagendadas); o status Realizada/No-show continua vindo dos campos
// adicionais do CRM (controle operacional do time).
// ============================================================

const CACHE_TTL_MS = 60_000;
if (!globalThis.__calcomCache) globalThis.__calcomCache = new Map();
const cache = globalThis.__calcomCache;

function send(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CalCom-Key');
  res.status(status).send(JSON.stringify(payload));
}

// Procura um telefone nas respostas do formulário de agendamento
function findPhone(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') {
      const digits = v.replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 14 && /^[\d\s()+.-]+$/.test(v.trim())) return digits;
    }
  }
  return '';
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CalCom-Key'); res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); return res.status(204).end(); }
  try {
    const key = req.headers['x-calcom-key'];
    if (!key) return send(res, 401, { error: true, code: 'NO_CALCOM_KEY', message: 'Chave do Cal.com ausente. Conecte na aba Reuniões.' });

    const ck = String(key).slice(-12);
    const force = (req.query || {}).force === '1';
    const cached = cache.get(ck);
    if (!force && cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
      return send(res, 200, { ...cached.payload, cached: true });
    }

    const H = { Authorization: 'Bearer ' + key, 'cal-api-version': '2024-08-13' };
    const all = [];
    for (let page = 0; page < 5; page++) {
      const r = await fetch('https://api.cal.com/v2/bookings?take=100&skip=' + page * 100, { headers: H });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return send(res, r.status === 401 || r.status === 403 ? 401 : 502, {
          error: true, code: 'CALCOM_' + r.status,
          message: r.status === 401 || r.status === 403 ? 'Chave do Cal.com inválida ou expirada.' : ('Cal.com respondeu HTTP ' + r.status),
          detail: txt.slice(0, 200)
        });
      }
      const d = await r.json();
      const batch = d.data || [];
      all.push(...batch);
      if (!(d.pagination && d.pagination.hasNextPage)) break;
    }

    // Tipos de evento (nome amigável por slug) — é o "quem FAZ a reunião"
    // quando a operação usa uma conta única com um tipo por consultor.
    const typeMap = {};
    try {
      const et = await (await fetch('https://api.cal.com/v2/event-types', { headers: { ...H, 'cal-api-version': '2024-06-14' } })).json();
      (et.data || []).forEach(t => { if (t.slug) typeMap[t.slug] = { title: t.title || t.slug, length: t.lengthInMinutes || null }; });
    } catch (e) { /* opcional */ }

    // Modalidade: o que vale é o LOCATION escolhido no agendamento — endereço físico
    // = presencial; link de vídeo = online. (meetingUrl NÃO serve de critério:
    // o Cal.com gera um link de Meet até pros agendamentos presenciais.)
    const modeOf = (b) => {
      const loc = typeof b.location === 'string' ? b.location : '';
      if (loc && !/^https?:\/\//i.test(loc) && !/^integrations?:/i.test(loc)) return 'presencial';
      return 'online';
    };

    const bookings = all.map(b => {
      const at = (b.attendees && b.attendees[0]) || {};
      const slug = (b.eventType && b.eventType.slug) || '';
      return {
        uid: b.uid,
        title: b.title || '',
        start: b.start,
        end: b.end,
        duration: b.duration || null,
        createdAt: b.createdAt || null,                       // quando foi AGENDADA
        status: b.status,                                     // accepted | cancelled | rejected | pending
        name: at.name || '',
        email: at.email || '',
        phone: findPhone(b.bookingFieldsResponses),
        absent: !!at.absent,                                  // no-show do cliente (marcado no Cal.com)
        absentHost: !!b.absentHost,                           // no-show do CONSULTOR
        host: (b.hosts && b.hosts[0] && b.hosts[0].name) || '',
        eventType: slug,
        eventTypeTitle: (typeMap[slug] && typeMap[slug].title) || slug,
        mode: modeOf(b),                                      // online | presencial
        rating: (typeof b.rating === 'number' && b.rating > 0) ? b.rating : null,
        cancellationReason: b.cancellationReason || '',
        rescheduled: !!b.rescheduledByEmail
      };
    });

    const payload = { bookings, eventTypes: typeMap, counts: { total: bookings.length }, fetchedAt: new Date().toISOString(), cached: false };
    cache.set(ck, { at: Date.now(), payload });
    return send(res, 200, payload);
  } catch (err) {
    return send(res, 500, { error: true, code: 'INTERNAL', message: err.message || 'Erro desconhecido' });
  }
};

module.exports.config = { maxDuration: 30 };
