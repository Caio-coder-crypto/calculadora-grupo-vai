// ============================================================
// GET /api/datacrazy/whoami
// Retorna o NOME do cliente para exibir no cabeçalho do painel,
// pra quem está usando a ferramenta saber QUAL cliente está vendo
// (evita a confusão de "de quem são esses números?").
//
// Fonte do nome:
//   `empresa` cadastrado no painel admin (Supabase, tabela clients).
//   Obs.: os dados de lead/CRM da API DataCrazy NÃO expõem o nome da
//   conta/tenant — confirmado inspecionando o payload de /leads. Por
//   isso a fonte confiável é o nome do painel (que o próprio cliente
//   citou como fallback). Se um dia a API DataCrazy expor um endpoint
//   de conta/perfil, basta plugar aqui antes do fallback.
//
// Exige a chave válida no header X-DataCrazy-Key (mesma do resto do app).
// ============================================================

const { getValidatedKey, getClientEmpresa, send, sendError, handleOptions } = require('./_client');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    const apiKey = await getValidatedKey(req);   // throws 401/403 se inválida/inativa
    const empresa = await getClientEmpresa(apiKey);

    send(res, 200, {
      ok: true,
      name: empresa || null,
      source: empresa ? 'painel' : null,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    sendError(res, err);
  }
};
