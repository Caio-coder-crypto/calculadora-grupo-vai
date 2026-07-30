// ============================================================
// GET /api/datacrazy/conversations
// Retorna conversas agregadas por mês, status e instância.
// IMPORTANTE: para o cálculo de "custo realizado", contamos
// conversas únicas iniciadas pela empresa (lastSendedMessageDate)
// como proxy de cobrança Meta (cada conversa = 1 janela 24h).
// ============================================================

const { dcGetAll, send, sendError, getValidatedKey, handleOptions } = require('../_client');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const { limit = 2000 } = req.query;
    const maxRecords = Math.min(parseInt(limit, 10) || 2000, 10000);
    const pageSize = 200;
    const maxPages = Math.ceil(maxRecords / pageSize);

    const { count, data } = await dcGetAll(apiKey, '/conversations', {}, pageSize, maxPages);

    // ---- Agregações ----
    const byMonth = {};         // YYYY-MM → { total, sentByCompany, receivedByClient }
    const byStatus = {};
    const byInstance = {};
    const byDepartment = {};

    let activeConversations = 0;
    let finishedConversations = 0;
    let pendingConversations = 0;

    for (const conv of data) {
      // Por mês (createdAt da conversa)
      if (conv.createdAt) {
        const ym = conv.createdAt.slice(0, 7);
        if (!byMonth[ym]) byMonth[ym] = { total: 0, sentByCompany: 0, receivedByClient: 0 };
        byMonth[ym].total++;

        // Quando a empresa enviou pelo menos uma mensagem, conta como "conversa cobrável"
        if (conv.lastSendedMessageDate) {
          byMonth[ym].sentByCompany++;
        }
        if (conv.lastReceivedMessageDate) {
          byMonth[ym].receivedByClient++;
        }
      }

      // Status
      if (Array.isArray(conv.statuses)) {
        for (const st of conv.statuses) {
          byStatus[st] = (byStatus[st] || 0) + 1;
        }
      }
      if (conv.finished) finishedConversations++;
      else if (conv.isPending) pendingConversations++;
      else activeConversations++;

      // Instância
      const inst = conv.instance?.name || 'Sem instância';
      byInstance[inst] = (byInstance[inst] || 0) + 1;

      // Departamento
      const dept = conv.currentDepartment?.name || 'Sem departamento';
      byDepartment[dept] = (byDepartment[dept] || 0) + 1;
    }

    send(res, 200, {
      total: count,
      sampled: data.length,
      stats: {
        active: activeConversations,
        finished: finishedConversations,
        pending: pendingConversations
      },
      byMonth: Object.entries(byMonth)
        .map(([month, v]) => ({ month, ...v }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      byStatus: Object.entries(byStatus)
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count),
      byInstance: Object.entries(byInstance)
        .map(([instance, count]) => ({ instance, count }))
        .sort((a, b) => b.count - a.count),
      byDepartment: Object.entries(byDepartment)
        .map(([department, count]) => ({ department, count }))
        .sort((a, b) => b.count - a.count),
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    sendError(res, err);
  }
};
