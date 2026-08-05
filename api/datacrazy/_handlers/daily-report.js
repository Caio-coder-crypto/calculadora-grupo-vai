// ============================================================
// GET /api/datacrazy/daily-report
// Preview do resumo diário — gera o texto e devolve. NÃO ENVIA NADA.
// O disparo é o daily-report-send.js (cron), que usa o MESMO núcleo.
//
// Query params:
//   - date        (YYYY-MM-DD) dia alvo. Default = ONTEM em horário de Brasília.
//   - pipelineId  (opcional) restringe o movimento de funil a um pipeline.
// ============================================================

const { send, sendError, getValidatedKey, handleOptions } = require('../_client');
const { buildDailyReport } = require('./_daily-report-core.js');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const report = await buildDailyReport(apiKey, {
      date: req.query.date,
      pipelineId: req.query.pipelineId || null
    });
    send(res, 200, { ...report, fetchedAt: new Date().toISOString() });
  } catch (err) {
    sendError(res, err);
  }
};
