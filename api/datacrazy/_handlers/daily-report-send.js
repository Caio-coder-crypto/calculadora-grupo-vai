// ============================================================
// GET/POST /api/datacrazy/daily-report-send
// Dispara o resumo diário no WhatsApp. Chamado pelo cron da Vercel.
//
// ---- SEGURANÇA ----
// Exige `Authorization: Bearer <CRON_SECRET>`. A Vercel injeta esse header
// automaticamente nas invocações de cron. Sem CRON_SECRET configurado o
// endpoint se RECUSA a rodar — melhor não disparar do que deixar qualquer um
// na internet mandando mensagem pros clientes batendo na URL.
//
// ---- CONFIGURAÇÃO (env var DAILY_REPORT_TARGETS) ----
// JSON array, um item por destinatário:
//   [
//     {
//       "label": "Happy Day",
//       "key": "<chave da API DataCrazy do tenant>",
//       "phone": "5585988842142",
//       "pipelineId": "<opcional: restringe o funil>",
//       "instanceId": "<opcional: força uma instância; senão escolhe a UAZAPI conectada>",
//       "enabled": true
//     }
//   ]
//
// ---- ENVIO ----
// Só por instância UAZAPI: a WhatsApp Cloud API (oficial Meta) exige template
// aprovado fora da janela de 24h e não envia em grupo. As credenciais da UAZAPI
// saem da própria config da instância no DataCrazy — nada de segredo duplicado.
//
// ---- MODO DE TESTE ----
// ?dry=1 monta tudo e devolve o texto SEM enviar. Use pra validar em produção
// sem torrar mensagem no WhatsApp de ninguém.
// ============================================================

const { dcGetAll, send, sendError, handleOptions } = require('../_client');
const { buildDailyReport } = require('./_daily-report-core.js');

function parseTargets() {
  const raw = process.env.DAILY_REPORT_TARGETS;
  if (!raw) return { error: 'DAILY_REPORT_TARGETS não configurada.' };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { error: 'DAILY_REPORT_TARGETS não é um JSON válido.' }; }
  if (!Array.isArray(parsed)) return { error: 'DAILY_REPORT_TARGETS precisa ser um array JSON.' };
  const targets = parsed.filter(t => t && t.enabled !== false && t.key && t.phone);
  return { targets };
}

// Só dígitos: a UAZAPI aceita "5585988842142". Deixa passar JID de grupo (@g.us).
function normalizePhone(p) {
  const s = String(p || '').trim();
  if (s.includes('@')) return s;
  return s.replace(/\D/g, '');
}

// Acha a instância UAZAPI conectada do tenant e devolve url+token.
async function findUazapiInstance(apiKey, forcedId) {
  const { data } = await dcGetAll(apiKey, '/instances', {}, 100, 5);
  const candidates = (data || []).filter(i =>
    (i.provider || '').toUpperCase() === 'UAZAPI' &&
    i.config?.uazapiUrl && i.config?.token
  );
  if (!candidates.length) return { error: 'Nenhuma instância UAZAPI encontrada neste tenant.' };
  const chosen = forcedId
    ? candidates.find(i => i.id === forcedId)
    : (candidates.find(i => i.isActive && i.status === 'CONNECTED') || candidates[0]);
  if (!chosen) return { error: `Instância ${forcedId} não encontrada ou não é UAZAPI.` };
  if (chosen.status !== 'CONNECTED') return { error: `Instância "${chosen.name}" está ${chosen.status}.` };
  return {
    url: String(chosen.config.uazapiUrl).replace(/\/+$/, ''),
    token: chosen.config.token,
    name: chosen.name
  };
}

async function sendText(inst, phone, text) {
  const res = await fetch(`${inst.url}/send/text`, {
    method: 'POST',
    headers: { 'token': inst.token, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ number: phone, text })
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  if (!res.ok) throw new Error(`UAZAPI HTTP ${res.status}: ${body.slice(0, 200)}`);
  return { messageId: json?.messageid || null, status: json?.status || null };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(res);

  try {
    // ---- Autenticação do cron ----
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return send(res, 503, {
        error: true, code: 'NO_CRON_SECRET',
        message: 'CRON_SECRET não configurada — disparo desabilitado por segurança.'
      });
    }
    const auth = req.headers?.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return send(res, 401, { error: true, code: 'UNAUTHORIZED', message: 'Autorização inválida.' });
    }

    const dry = req.query?.dry === '1';
    const dateOverride = req.query?.date || null;

    const { targets, error } = parseTargets();
    if (error) return send(res, 500, { error: true, code: 'BAD_CONFIG', message: error });
    if (!targets.length) return send(res, 200, { sent: 0, results: [], message: 'Nenhum destinatário ativo.' });

    // Sequencial de propósito: são poucos destinatários e cada um baixa a base
    // inteira do tenant. Em paralelo estoura memória e rate-limit da API.
    const results = [];
    for (const t of targets) {
      const label = t.label || t.phone;
      try {
        const report = await buildDailyReport(t.key, { date: dateOverride, pipelineId: t.pipelineId || null });
        const phone = normalizePhone(t.phone);
        if (dry) {
          results.push({ label, phone, ok: true, dry: true, date: report.date, text: report.text });
          continue;
        }
        const inst = await findUazapiInstance(t.key, t.instanceId);
        if (inst.error) { results.push({ label, ok: false, error: inst.error }); continue; }
        const sent = await sendText(inst, phone, report.text);
        results.push({ label, phone, ok: true, date: report.date, instance: inst.name, ...sent });
      } catch (err) {
        // Um destinatário quebrado não pode impedir os outros de receber.
        results.push({ label, ok: false, error: err.message || String(err) });
      }
    }

    send(res, 200, {
      dry,
      total: results.length,
      sent: results.filter(r => r.ok && !r.dry).length,
      failed: results.filter(r => !r.ok).length,
      results,
      firedAt: new Date().toISOString()
    });
  } catch (err) {
    sendError(res, err);
  }
};
