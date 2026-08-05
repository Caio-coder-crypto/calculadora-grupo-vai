// ============================================================
// /api/datacrazy/[action] — UMA função serverless atende TODOS os
// endpoints do grupo DataCrazy (o plano Hobby do Vercel limita 12
// funções por deploy; este grupo tinha 10 arquivos).
//
// As URLs do front NÃO mudam: /api/datacrazy/summary chega aqui com
// req.query.action = 'summary' (rota dinâmica do Vercel) e é roteada
// pro handler real em _handlers/ (prefixo _ = Vercel não vira função).
// ============================================================

const HANDLERS = {
  'activities':         () => require('./_handlers/activities.js'),
  'bi-data':            () => require('./_handlers/bi-data.js'),
  'bi-leads':           () => require('./_handlers/bi-leads.js'),
  'conversations':      () => require('./_handlers/conversations.js'),
  'daily-report':       () => require('./_handlers/daily-report.js'),
  'daily-productivity': () => require('./_handlers/daily-productivity.js'),
  'instances':          () => require('./_handlers/instances.js'),
  'leads':              () => require('./_handlers/leads.js'),
  'meetings':           () => require('./_handlers/meetings.js'),
  'prospect':           () => require('./_handlers/prospect.js'),
  'summary':            () => require('./_handlers/summary.js'),
  'whoami':             () => require('./_handlers/whoami.js')
};

module.exports = async function handler(req, res) {
  const action = String((req.query && req.query.action) || '');
  const load = Object.prototype.hasOwnProperty.call(HANDLERS, action) ? HANDLERS[action] : null;
  if (!load) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(404).send(JSON.stringify({ error: true, code: 'NOT_FOUND', message: 'Endpoint desconhecido: ' + action }));
  }
  return load()(req, res);
};

// maxDuration único da função consolidada = o maior entre os handlers (bi-data/summary: 60)
module.exports.config = { maxDuration: 60 };
