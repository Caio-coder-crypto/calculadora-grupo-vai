// ============================================================
// GET /api/datacrazy/instances
// Retorna lista de instâncias WhatsApp conectadas ao tenant.
// Usado pra que o cliente marque quais são oficiais Meta
// (cobradas) vs Evolution/não-oficial (sem custo).
// ============================================================

const { dcGetAll, send, sendError, getValidatedKey, handleOptions } = require('../_client');

// Heurística pra sugerir se a instância é "Oficial Meta"
// Provider/engine que indicam API Oficial:
const OFFICIAL_PROVIDERS = new Set([
  'OFFICIAL_API', 'META_OFFICIAL', 'META_API', 'CLOUD_API',
  'WHATSAPP_CLOUD_API', 'WABA', 'WHATSAPP_BUSINESS_API'
]);
// Provider/engine que indicam NÃO-oficial (Evolution, Baileys, etc.):
const NON_OFFICIAL_PROVIDERS = new Set([
  'EVOLUTION_API', 'EVOLUTION', 'BAILEYS', 'WPPCONNECT', 'WA_AUTOMATE'
]);

function suggestIsOfficial(inst) {
  const provider = (inst.provider || '').toUpperCase();
  const engine   = (inst.engine   || '').toUpperCase();
  if (OFFICIAL_PROVIDERS.has(provider) || OFFICIAL_PROVIDERS.has(engine)) return true;
  if (NON_OFFICIAL_PROVIDERS.has(provider) || NON_OFFICIAL_PROVIDERS.has(engine)) return false;
  return null;  // desconhecido — cliente decide
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);
    const { count, data } = await dcGetAll(apiKey, '/instances', {}, 100, 5);

    // Limpa dados sensíveis (tokens não devem vazar pro frontend)
    const safe = data.map(inst => ({
      id:             inst.id,
      name:           inst.name,
      platform:       inst.platform,
      provider:       inst.provider,
      engine:         inst.engine,
      status:         inst.status,        // CONNECTED / DISCONNECTED
      isActive:       inst.isActive,
      createdAt:      inst.createdAt,
      suggestedOfficial: suggestIsOfficial(inst)
    }));

    // Resumo
    const summary = {
      total:                  safe.length,
      whatsappOnly:           safe.filter(i => i.platform === 'WHATSAPP').length,
      connected:              safe.filter(i => i.status === 'CONNECTED').length,
      suggestedOfficial:      safe.filter(i => i.suggestedOfficial === true).length,
      suggestedNonOfficial:   safe.filter(i => i.suggestedOfficial === false).length,
      undetermined:           safe.filter(i => i.suggestedOfficial === null).length
    };

    send(res, 200, {
      total: count,
      summary,
      data: safe,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    sendError(res, err);
  }
};
