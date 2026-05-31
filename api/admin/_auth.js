// ============================================================
// AUTENTICAÇÃO ADMIN — validação simples por senha
// ============================================================
// Senha vem da env var ADMIN_PASSWORD. Quem souber a senha, entra.
// É um painel interno de gestão da Grupo VAI — sem necessidade
// de JWT, sessões ou usuários múltiplos.
//
// Fluxo:
//   1. Usuário digita senha no admin.html
//   2. Frontend salva no localStorage como 'admin_token'
//   3. Toda chamada à API envia header X-Admin-Password: <senha>
//   4. Backend compara contra env. Match = libera. Mismatch = 401.
// ============================================================

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function checkAdminAuth(req) {
  if (!ADMIN_PASSWORD) {
    const err = new Error('Painel admin desabilitado: defina ADMIN_PASSWORD na env.');
    err.status = 503;
    throw err;
  }
  const provided = req.headers['x-admin-password'] || req.headers['X-Admin-Password'] || '';
  if (!provided || String(provided) !== ADMIN_PASSWORD) {
    const err = new Error('Senha admin incorreta.');
    err.status = 401;
    err.code = 'ADMIN_AUTH_FAILED';
    throw err;
  }
  return true;
}

// ============================================================
// Cliente Supabase (compartilhado com o backend DataCrazy)
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } catch (err) {
    console.error('[admin] Falha ao carregar Supabase:', err.message);
  }
}

function getSupabase() {
  if (!supabase) {
    const err = new Error('Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_KEY.');
    err.status = 503;
    throw err;
  }
  return supabase;
}

// ============================================================
// Helpers de resposta
// ============================================================
function send(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.status(status).send(JSON.stringify(payload));
}

function sendError(res, err) {
  console.error('[admin]', err.message || err);
  const status = err?.status || 500;
  send(res, status, {
    error: true,
    code: err?.code || 'INTERNAL',
    message: err?.message || 'Erro desconhecido'
  });
}

function handleOptions(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  res.statusCode = 204;
  res.end();
}

// ============================================================
// Invalida cache de auth do _client.js
// Quando admin muda is_active de um cliente, o cache de validação
// do backend principal ainda tem o status antigo (TTL 60s). Limpa
// imediatamente pra que a mudança tome efeito agora.
// ============================================================
function invalidateAuthCache(apiKey) {
  if (globalThis.__dcAuthCache) {
    if (apiKey) globalThis.__dcAuthCache.delete(apiKey);
    else globalThis.__dcAuthCache.clear();
  }
}

module.exports = {
  checkAdminAuth,
  getSupabase,
  send,
  sendError,
  handleOptions,
  invalidateAuthCache
};
