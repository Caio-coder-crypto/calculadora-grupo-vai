// ============================================================
// CRUD /api/admin/clients — gestão de clientes do painel
//
// Métodos:
//   GET    /api/admin/clients              → lista todos
//   POST   /api/admin/clients              → cria novo (empresa + api_key)
//   PATCH  /api/admin/clients?id=<uuid>    → atualiza (empresa, is_active)
//   DELETE /api/admin/clients?id=<uuid>    → remove
//
// Todos exigem header X-Admin-Password validado.
// ============================================================

const { checkAdminAuth, getSupabase, send, sendError, handleOptions, invalidateAuthCache } = require('./_auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    checkAdminAuth(req);
    const supabase = getSupabase();

    if (req.method === 'GET') {
      return await listClients(supabase, req, res);
    }
    if (req.method === 'POST') {
      return await createClient(supabase, req, res);
    }
    if (req.method === 'PATCH') {
      return await updateClient(supabase, req, res);
    }
    if (req.method === 'DELETE') {
      return await deleteClient(supabase, req, res);
    }

    send(res, 405, { error: true, message: 'Método não suportado' });
  } catch (err) {
    sendError(res, err);
  }
};

// ============================================================
// GET — Lista todos
// ============================================================
async function listClients(supabase, req, res) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, empresa, api_key, is_active, created_at')
    .order('created_at', { ascending: false });

  if (error) throw new Error('Erro Supabase: ' + error.message);

  // NUNCA retorna a api_key completa: uma senha de admin comprometida daria
  // acesso direto ao CRM de TODOS os tenants. O id (UUID) identifica o cliente
  // nas operações de edição/remoção — a chave não precisa trafegar.
  const safe = data.map(c => ({
    id: c.id,
    empresa: c.empresa,
    api_key_preview: c.api_key ? '…' + c.api_key.slice(-8) : '',
    is_active: c.is_active,
    created_at: c.created_at
  }));

  send(res, 200, {
    total: safe.length,
    active: safe.filter(c => c.is_active).length,
    inactive: safe.filter(c => !c.is_active).length,
    data: safe
  });
}

// ============================================================
// POST — Cria novo cliente
// Body: { empresa, api_key, is_active? }
// ============================================================
async function createClient(supabase, req, res) {
  const body = await readJsonBody(req);
  const empresa = (body.empresa || '').trim();
  const api_key = (body.api_key || '').trim();
  const is_active = body.is_active !== false;  // default true

  if (!empresa || empresa.length < 2) {
    return send(res, 400, { error: true, message: 'Nome da empresa obrigatório (mínimo 2 caracteres).' });
  }
  if (!api_key || api_key.length < 10) {
    return send(res, 400, { error: true, message: 'Chave de API obrigatória (mínimo 10 caracteres).' });
  }

  const { data, error } = await supabase
    .from('clients')
    .insert({ empresa, api_key, is_active })
    .select()
    .single();

  if (error) {
    if (error.code === '23505' || /duplicate/i.test(error.message)) {
      return send(res, 409, { error: true, code: 'DUPLICATE_KEY', message: 'Esta chave de API já está cadastrada para outro cliente.' });
    }
    throw new Error('Erro Supabase: ' + error.message);
  }

  send(res, 201, { ok: true, message: 'Cliente cadastrado com sucesso.', data });
}

// ============================================================
// PATCH — Atualiza cliente existente
// Query: ?id=<uuid>
// Body: { empresa?, is_active? }
// ============================================================
async function updateClient(supabase, req, res) {
  const id = req.query?.id;
  if (!id) return send(res, 400, { error: true, message: 'Parâmetro ?id= obrigatório.' });

  const body = await readJsonBody(req);
  const updates = {};
  if (typeof body.empresa === 'string' && body.empresa.trim()) updates.empresa = body.empresa.trim();
  if (typeof body.is_active === 'boolean') updates.is_active = body.is_active;

  if (Object.keys(updates).length === 0) {
    return send(res, 400, { error: true, message: 'Nenhum campo válido para atualizar.' });
  }

  // Pega a api_key atual antes de atualizar (pra invalidar cache)
  const { data: current } = await supabase
    .from('clients')
    .select('api_key')
    .eq('id', id)
    .maybeSingle();

  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error('Erro Supabase: ' + error.message);
  if (!data) return send(res, 404, { error: true, message: 'Cliente não encontrado.' });

  // Invalida cache de validação pra mudança ter efeito imediato (não esperar 60s)
  if (current?.api_key) invalidateAuthCache(current.api_key);

  send(res, 200, { ok: true, message: 'Cliente atualizado.', data });
}

// ============================================================
// DELETE — Remove cliente permanentemente
// Query: ?id=<uuid>
// ============================================================
async function deleteClient(supabase, req, res) {
  const id = req.query?.id;
  if (!id) return send(res, 400, { error: true, message: 'Parâmetro ?id= obrigatório.' });

  // Pega api_key antes de deletar (pra invalidar cache)
  const { data: current } = await supabase
    .from('clients')
    .select('api_key, empresa')
    .eq('id', id)
    .maybeSingle();

  if (!current) return send(res, 404, { error: true, message: 'Cliente não encontrado.' });

  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('id', id);

  if (error) throw new Error('Erro Supabase: ' + error.message);

  invalidateAuthCache(current.api_key);

  send(res, 200, { ok: true, message: `Cliente "${current.empresa}" removido.` });
}

// ============================================================
// Helper: lê JSON body do request (suporta Vercel + dev server)
// ============================================================
async function readJsonBody(req) {
  // Vercel já parseia body automaticamente em algumas situações
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Fallback: lê stream
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
