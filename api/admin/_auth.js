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

const crypto = require('crypto');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Rate limit em memória por IP: a senha admin destranca a gestão de todos os
// tenants e era testável infinitas vezes (inclusive de outra origem, via ACAO:*).
if (!globalThis.__adminRl) globalThis.__adminRl = new Map();
const rl = globalThis.__adminRl;
const RL_WINDOW_MS = 15 * 60_000;
const RL_MAX_FAILS = 5;

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Comparação em tempo constante (o !== vazava o tamanho do prefixo correto).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);   // gasta o mesmo tempo, não vaza o tamanho
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function checkAdminAuth(req) {
  if (!ADMIN_PASSWORD) {
    const err = new Error('Painel admin desabilitado: defina ADMIN_PASSWORD na env.');
    err.status = 503;
    throw err;
  }
  const ip = clientIp(req);
  const now = Date.now();
  const entry = rl.get(ip);
  if (entry && entry.until > now && entry.fails >= RL_MAX_FAILS) {
    const err = new Error('Muitas tentativas. Tente novamente em alguns minutos.');
    err.status = 429;
    err.code = 'RATE_LIMITED';
    throw err;
  }
  const provided = req.headers['x-admin-password'] || req.headers['X-Admin-Password'] || '';
  if (!provided || !safeEqual(provided, ADMIN_PASSWORD)) {
    const cur = (entry && entry.until > now) ? entry : { fails: 0, until: now + RL_WINDOW_MS };
    cur.fails++;
    rl.set(ip, cur);
    const err = new Error('Senha admin incorreta.');
    err.status = 401;
    err.code = 'ADMIN_AUTH_FAILED';
    throw err;
  }
  rl.delete(ip);
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
  // Sem wildcard: o painel admin é same-origin. ACAO:* permitia que qualquer
  // site tentasse a senha (e lesse a resposta) a partir do navegador da vítima.
  res.setHeader('Vary', 'Origin');
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
  // Sem wildcard: o painel admin é same-origin. ACAO:* permitia que qualquer
  // site tentasse a senha (e lesse a resposta) a partir do navegador da vítima.
  res.setHeader('Vary', 'Origin');
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
