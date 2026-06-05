// ============================================================
// GET /api/meta/insights
// Proxy autenticado para a Graph API do Meta (Marketing API).
// Retorna o `spend` (investimento) do período + série diária
// (pra "consumo diário médio") + breakdown por campanha
// (pra "investimento por canal" / CAC por canal).
//
// Sintaxe baseada na doc oficial do Facebook Developers:
//   GET /v19.0/act_{AD_ACCOUNT_ID}/insights
//       ?fields=spend,impressions,clicks,actions
//       &time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
//       &level=account|campaign
//       &time_increment=1            (1 = quebra dia-a-dia)
//       &access_token=...
//
// Multi-tenant: o token e o ad account são DO CLIENTE. Ele cola na UI
// (Gastos & ROI) e nós só fazemos o proxy (igual fazemos com a chave DataCrazy).
// NÃO logamos token nem o gravamos em lugar nenhum.
// ============================================================

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function send(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Meta-Token');
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

function handleOptions(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Meta-Token');
  res.statusCode = 204;
  res.end();
}

// Normaliza "act_123" / "123" → "act_123"
function normalizeAccount(id) {
  if (!id) return null;
  const clean = String(id).trim().replace(/^act_/, '');
  return /^\d+$/.test(clean) ? `act_${clean}` : null;
}

// Soma os action_type que representam LEAD (varia conforme setup do pixel).
function sumLeadActions(actions) {
  if (!Array.isArray(actions)) return 0;
  let leads = 0;
  for (const a of actions) {
    if (/lead/i.test(a.action_type || '')) leads += Number(a.value || 0);
  }
  return leads;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    // ---- Auth do Meta (token do cliente) — SOMENTE via header, nunca querystring (evita vazar em logs) ----
    const token = (req.headers['x-meta-token'] || '').toString().trim();
    if (!token) {
      return send(res, 401, { error: true, code: 'NO_META_TOKEN', message: 'Token do Meta ausente. Cole o token na aba Gastos & ROI.' });
    }

    const account = normalizeAccount(req.query.account || req.query.adAccountId);
    if (!account) {
      return send(res, 400, { error: true, code: 'BAD_ACCOUNT', message: 'Ad Account inválido. Use o ID numérico (ex: 1234567890) ou act_1234567890.' });
    }

    // ---- Período (default: mês atual até hoje) ----
    const since = (req.query.since || '').toString();
    const until = (req.query.until || '').toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return send(res, 400, { error: true, code: 'BAD_RANGE', message: 'Informe since e until no formato YYYY-MM-DD.' });
    }

    // account | campaign (campaign = breakdown por canal/campanha pra CAC por canal)
    const level = req.query.level === 'campaign' ? 'campaign' : 'account';

    // ---- Monta a URL da Graph API (sintaxe oficial) ----
    const url = new URL(`${GRAPH_BASE}/${account}/insights`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('level', level);
    url.searchParams.set('time_range', JSON.stringify({ since, until }));
    url.searchParams.set('time_increment', '1'); // quebra dia-a-dia (consumo diário)
    url.searchParams.set('limit', '500');
    const fields = ['spend', 'impressions', 'clicks', 'cpc', 'cpm', 'ctr', 'actions', 'date_start', 'date_stop'];
    if (level === 'campaign') fields.push('campaign_id', 'campaign_name');
    url.searchParams.set('fields', fields.join(','));

    // ---- Paginação + agregação INCREMENTAL (não acumula linhas em memória) ----
    let totalSpend = 0, totalLeads = 0, totalImpr = 0, totalClicks = 0;
    const byDay = {};
    const byCampaign = {};
    const deadline = Date.now() + 45000;  // teto de tempo (função tem maxDuration 60s)

    let next = url.toString();
    let guard = 0;
    while (next && guard < 50) {
      guard++;
      if (Date.now() > deadline) break;  // aborta antes do timeout serverless
      const r = await fetch(next, { headers: { Accept: 'application/json' } });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        const fbErr = json?.error || {};
        return send(res, r.status, {
          error: true,
          code: 'META_API_ERROR',
          message: fbErr.message || `Graph API HTTP ${r.status}`,
          metaCode: fbErr.code,
          metaType: fbErr.type,
          hint: fbErr.code === 190 ? 'Token expirado/ inválido — gere um novo no Business Manager.' : undefined
        });
      }
      for (const row of (json.data || [])) {
        const spend = Number(row.spend || 0);
        const leads = sumLeadActions(row.actions);
        totalSpend  += spend;
        totalLeads  += leads;
        totalImpr   += Number(row.impressions || 0);
        totalClicks += Number(row.clicks || 0);

        const day = row.date_start;
        if (day) {
          if (!byDay[day]) byDay[day] = { day, spend: 0, leads: 0 };
          byDay[day].spend += spend;
          byDay[day].leads += leads;
        }
        if (level === 'campaign') {
          const key = row.campaign_id || row.campaign_name || 'sem_campanha';
          if (!byCampaign[key]) byCampaign[key] = { id: row.campaign_id, name: row.campaign_name || 'Sem campanha', spend: 0, leads: 0 };
          byCampaign[key].spend += spend;
          byCampaign[key].leads += leads;
        }
      }
      next = json.paging?.next || null;
    }

    const days = Object.keys(byDay).length || 1;
    const dailyAvg = totalSpend / days;

    send(res, 200, {
      ok: true,
      account,
      range: { since, until },
      level,
      spend: Number(totalSpend.toFixed(2)),
      metaLeads: totalLeads,                  // leads atribuídos pelo pixel (pode divergir do CRM)
      impressions: totalImpr,
      clicks: totalClicks,
      dailyAvgSpend: Number(dailyAvg.toFixed(2)),
      // CPL via leads DO META (o frontend pode recalcular com leads do DataCrazy):
      costPerMetaLead: totalLeads > 0 ? Number((totalSpend / totalLeads).toFixed(2)) : null,
      byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
      byCampaign: Object.values(byCampaign).sort((a, b) => b.spend - a.spend),
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    send(res, 500, { error: true, code: 'INTERNAL', message: err?.message || 'Erro ao consultar o Meta.' });
  }
};
