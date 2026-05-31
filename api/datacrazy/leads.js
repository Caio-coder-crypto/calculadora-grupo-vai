// ============================================================
// GET /api/datacrazy/leads
// Multi-tenant: lê chave do header X-DataCrazy-Key
// ============================================================

const { dcGetAll, send, sendError, getValidatedKey, handleOptions } = require('./_client');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const { limit = 2500 } = req.query;
    const maxRecords = Math.min(parseInt(limit, 10) || 2500, 10000);
    const pageSize = 200;
    const maxPages = Math.ceil(maxRecords / pageSize);

    const { count, data } = await dcGetAll(apiKey, '/leads', {}, pageSize, maxPages);

    const bySource = {};
    const byMonth = {};
    const byTag = {};
    let withPhone = 0, withEmail = 0, withPurchase = 0, totalSpentSum = 0;

    for (const lead of data) {
      const src = lead.source || 'Sem origem';
      bySource[src] = (bySource[src] || 0) + 1;

      if (lead.createdAt) {
        const ym = lead.createdAt.slice(0, 7);
        byMonth[ym] = (byMonth[ym] || 0) + 1;
      }

      if (Array.isArray(lead.tags)) {
        for (const tag of lead.tags) {
          const tname = tag.name || 'sem-nome';
          byTag[tname] = (byTag[tname] || 0) + 1;
        }
      }

      if (lead.phone) withPhone++;
      if (lead.email) withEmail++;
      if (lead.metrics?.purchaseCount > 0) withPurchase++;
      totalSpentSum += lead.metrics?.totalSpent || 0;
    }

    send(res, 200, {
      total: count,
      sampled: data.length,
      stats: { withPhone, withEmail, withPurchase, totalRevenue: totalSpentSum },
      bySource: Object.entries(bySource).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
      byMonth: Object.entries(byMonth).map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
      byTag: Object.entries(byTag).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 20),
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    sendError(res, err);
  }
};
