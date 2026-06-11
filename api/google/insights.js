// ============================================================
// GET /api/google/insights
// Proxy autenticado para a Google Ads API — retorna o `spend`
// (investimento) do período + série diária + breakdown por campanha.
// Espelha /api/meta/insights.
//
// DIFERENÇA pro Meta: a Google Ads API exige OAuth2 (o access token
// expira em ~1h) + developer token. Por isso as credenciais são da
// AGÊNCIA (Grupo VAI) e ficam no SERVIDOR (env vars). O cliente só
// informa o Customer ID da conta dele (?customerId=). Modelo MCC:
// uma autenticação da agência atende todas as contas gerenciadas.
//
// Setup único (env vars) — ver DEPLOY.md:
//   GOOGLE_ADS_DEVELOPER_TOKEN     developer token (aprovado no MCC)
//   GOOGLE_ADS_CLIENT_ID           OAuth client id (Google Cloud)
//   GOOGLE_ADS_CLIENT_SECRET       OAuth client secret
//   GOOGLE_ADS_REFRESH_TOKEN       refresh token da agência (gerado 1x)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID   ID do MCC (manager) — só dígitos
//   GOOGLE_ADS_API_VERSION         (opcional) ex.: v24 (versão atual em 2026)
// ============================================================

const API_VERSION   = process.env.GOOGLE_ADS_API_VERSION || 'v24';
const ADS_BASE      = `https://googleads.googleapis.com/${API_VERSION}`;
const OAUTH_URL     = 'https://oauth2.googleapis.com/token';

const DEV_TOKEN     = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN || '';
const LOGIN_CID     = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/\D/g, '');

function send(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DataCrazy-Key');
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

function handleOptions(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DataCrazy-Key');
  res.statusCode = 204;
  res.end();
}

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

// ---- Cache do access token (por refresh token) ----
// Sobrevive ao warm lambda (Vercel reusa o módulo na mesma instância).
if (!globalThis.__gAdsTokenCache) globalThis.__gAdsTokenCache = new Map();
const tokenCache = globalThis.__gAdsTokenCache;

async function getAccessToken() {
  const cached = tokenCache.get(REFRESH_TOKEN);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type:    'refresh_token'
  });
  const r = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    const err = new Error(json.error_description || json.error || `OAuth HTTP ${r.status}`);
    err.code = 'GOOGLE_AUTH_ERROR';
    throw err;
  }
  const token = json.access_token;
  const exp = Date.now() + ((Number(json.expires_in) || 3600) * 1000);
  tokenCache.set(REFRESH_TOKEN, { token, exp });
  return token;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    // ---- Credenciais da agência configuradas? ----
    if (!DEV_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !LOGIN_CID) {
      return send(res, 501, {
        error: true,
        code: 'GOOGLE_NOT_CONFIGURED',
        message: 'Google Ads ainda não está configurado no servidor. Faltam as credenciais da agência (developer token + OAuth). Veja a seção Google Ads no DEPLOY.md.'
      });
    }

    // ---- Customer ID do cliente (só dígitos) ----
    const customerId = onlyDigits(req.query.customerId || req.query.customer);
    if (!/^\d{8,12}$/.test(customerId)) {
      return send(res, 400, { error: true, code: 'BAD_CUSTOMER', message: 'Customer ID inválido. Use o ID da conta Google Ads (ex.: 123-456-7890).' });
    }

    // ---- Período ----
    const since = String(req.query.since || '');
    const until = String(req.query.until || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return send(res, 400, { error: true, code: 'BAD_RANGE', message: 'Informe since e until no formato YYYY-MM-DD.' });
    }

    const accessToken = await getAccessToken();

    // GAQL — custo por dia e por campanha no período.
    // cost_micros vem na moeda da conta, em micros (÷ 1.000.000).
    const query =
      'SELECT segments.date, metrics.cost_micros, metrics.conversions, campaign.id, campaign.name ' +
      `FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`;

    const r = await fetch(`${ADS_BASE}/customers/${customerId}/googleAds:searchStream`, {
      method: 'POST',
      headers: {
        'Authorization':     `Bearer ${accessToken}`,
        'developer-token':   DEV_TOKEN,
        'login-customer-id': LOGIN_CID,
        'Content-Type':      'application/json',
        'Accept':            'application/json'
      },
      body: JSON.stringify({ query })
    });
    const json = await r.json().catch(() => ({}));

    if (!r.ok) {
      const gErr = (Array.isArray(json) ? json[0]?.error : json?.error) || {};
      return send(res, r.status, {
        error: true,
        code: 'GOOGLE_API_ERROR',
        message: gErr.message || `Google Ads API HTTP ${r.status}`,
        status: gErr.status,
        hint: r.status === 401 ? 'Token/credenciais da agência inválidos — confira as env vars do Google Ads.'
            : r.status === 403 ? 'Sem permissão nessa conta. Confira o developer token e se o Customer ID está sob o MCC.'
            : undefined
      });
    }

    // searchStream → array de chunks, cada um com .results[]
    const chunks = Array.isArray(json) ? json : [json];
    let totalSpend = 0, totalConv = 0;
    const byDay = {}, byCampaign = {};

    for (const chunk of chunks) {
      for (const row of (chunk.results || [])) {
        const spend = Number(row.metrics?.costMicros || 0) / 1e6;
        const conv  = Number(row.metrics?.conversions || 0);
        totalSpend += spend;
        totalConv  += conv;

        const day = row.segments?.date;
        if (day) {
          if (!byDay[day]) byDay[day] = { day, spend: 0, conversions: 0 };
          byDay[day].spend       += spend;
          byDay[day].conversions += conv;
        }
        const cid = row.campaign?.id || 'sem_campanha';
        if (!byCampaign[cid]) byCampaign[cid] = { id: row.campaign?.id, name: row.campaign?.name || 'Sem campanha', spend: 0, conversions: 0 };
        byCampaign[cid].spend       += spend;
        byCampaign[cid].conversions += conv;
      }
    }

    const days = Object.keys(byDay).length || 1;

    send(res, 200, {
      ok: true,
      customerId,
      range: { since, until },
      spend: Number(totalSpend.toFixed(2)),
      conversions: Number(totalConv.toFixed(2)),
      dailyAvgSpend: Number((totalSpend / days).toFixed(2)),
      byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
      byCampaign: Object.values(byCampaign).sort((a, b) => b.spend - a.spend),
      currencyNote: 'Valores na moeda da conta Google Ads (contas BR = BRL).',
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    const code = err.code || 'INTERNAL';
    const status = code === 'GOOGLE_AUTH_ERROR' ? 401 : 500;
    send(res, status, { error: true, code, message: err?.message || 'Erro ao consultar o Google Ads.' });
  }
};
