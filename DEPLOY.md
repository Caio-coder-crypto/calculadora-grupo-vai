# 🚀 Guia de Deploy — Calculadora Grupo VAI

Como subir essa calculadora pra Vercel e entregar uma URL única que **todos os seus clientes vão usar**, cada um com sua própria chave da API DataCrazy.

---

## 🎯 O modelo de entrega

```
   UMA URL PÚBLICA: https://calculadora-vai.vercel.app
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
    Cliente A           Cliente B           Cliente N
   cola chave dele     cola chave dele     cola chave dele
   (localStorage)      (localStorage)      (localStorage)
```

**Você atualiza o código uma vez** → todos os clientes recebem na mesma hora.
**Cliente novo** = só mandar o link. Sem configuração do seu lado.

---

## 📋 Pré-requisitos

1. Conta no [GitHub](https://github.com) (grátis)
2. Conta no [Vercel](https://vercel.com) (grátis — login com GitHub)
3. Git instalado (`git --version` no terminal pra confirmar)

---

## 🔧 Passo 1 — Subir o código pro GitHub

Abra o terminal nessa pasta (`C:\Users\Administrador\`):

```bash
# Inicializa o repositório Git
git init
git add .
git commit -m "Calculadora Grupo VAI v1.0"

# Cria repositório no GitHub:
# 1. Vai em https://github.com/new
# 2. Nome: calculadora-grupo-vai
# 3. Privado (recomendado)
# 4. NÃO marcar "initialize with README"
# 5. Copiar a URL que aparece (ex: https://github.com/seu-usuario/calculadora-grupo-vai.git)

# Vincula e envia
git remote add origin https://github.com/SEU-USUARIO/calculadora-grupo-vai.git
git branch -M main
git push -u origin main
```

⚠️ **Confira** que o `.gitignore` está protegendo o `.env.local` — esse arquivo NÃO deve subir pro GitHub.

---

## 🌐 Passo 2 — Deploy no Vercel

1. Acesse [vercel.com](https://vercel.com) e faça login com sua conta GitHub
2. Clique em **Add New → Project**
3. Importe o repositório `calculadora-grupo-vai`
4. Em **Configure Project**:
   - **Framework Preset:** Other
   - **Build Command:** (deixar vazio)
   - **Output Directory:** (deixar vazio)
   - **Install Command:** (deixar vazio)
5. **Environment Variables** (importante!):
   - **DEIXAR VAZIO.** Em produção, cada cliente cola a chave dele no navegador. Você não precisa configurar nada aqui.
6. Clica em **Deploy**

Em ~30 segundos a Vercel te dá a URL: `https://calculadora-grupo-vai.vercel.app`

---

## 📤 Passo 3 — Entregar pros clientes

Manda o link no WhatsApp do cliente com este texto-modelo:

```
Olá [Cliente],

Aqui está a Calculadora de Custos WhatsApp Business API + Dashboard do seu CRM:

🔗 https://calculadora-grupo-vai.vercel.app

Como configurar (1x só):
1. Abra o link
2. Clique no botão "⚙️ Configurar DataCrazy" (canto superior direito)
3. Cole sua chave da API (gere uma em Configurações → API Keys no DataCrazy)
4. Salvar

Pronto! A partir daí você terá:
✅ Calculadora de custos por categoria de mensagem
✅ Dashboard com gasto realizado × projetado do mês
✅ Simulador de disparo (quanto vou gastar se mandar X mensagens?)

Sua chave fica salva apenas no seu navegador — nenhum dado passa pelos nossos servidores.

Qualquer dúvida, é só chamar.
— Grupo VAI
```

---

## 🔄 Passo 4 — Como atualizar o código depois

Quando você melhorar a calculadora:

```bash
git add .
git commit -m "Adiciona feature X"
git push
```

Vercel detecta o push e **redeploya automaticamente em ~30 segundos**. Todos os clientes recebem a atualização sem fazer nada.

---

## 🏷️ Passo 5 (opcional) — Domínio próprio

Se quiser uma URL mais bonita tipo `calculadora.grupovai.com.br`:

1. No painel do Vercel → seu projeto → **Settings → Domains**
2. Adicionar `calculadora.grupovai.com.br`
3. Vercel mostra as instruções de DNS (configurar CNAME)
4. Configurar no painel do seu registrador (Registro.br, GoDaddy, etc.)
5. Aguardar propagação (5min a 24h)

Custo: zero adicional. Vercel já dá HTTPS automático.

---

## 🔐 Boas práticas de segurança (mande pros clientes)

1. **Gere uma chave por cliente** — não reaproveite chaves
2. **Permissões mínimas** — só leitura nos módulos necessários
3. **Revogue** chaves de funcionários que saíram
4. **Não compartilhe** chaves em e-mail/WhatsApp não criptografado
5. A chave fica **apenas no navegador** do cliente — se ele limpar o cache, vai precisar configurar de novo (isso é proposital)

---

## 📊 Como acompanhar uso

No painel do Vercel você vê:
- Quantas requisições foram feitas
- Tempo médio de resposta
- Erros (com logs)
- Bandwidth consumido

Tier grátis suporta milhares de requisições/mês — mais que suficiente pra dezenas de clientes ativos.

---

## ❓ Problemas comuns

**"O dashboard mostra erro 401"**
→ O cliente colou uma chave inválida ou expirada. Pede pra ele gerar uma nova no DataCrazy.

**"O cliente reclama que perdeu a configuração"**
→ Ele limpou o cache do navegador. Manda ele reconfigurar (1 clique).

**"Posso ver os dados de um cliente?"**
→ Não, e isso é proposital. A chave fica no browser dele. Se ele quiser que você veja, ele precisa te dar acesso à chave dele temporariamente.

---

## 🚀 Próximos passos sugeridos

Quando tiver uns 10+ clientes ativos:

1. **Analytics próprio** — adiciona Vercel Analytics (gratis) pra ver quem acessa
2. **Lista de clientes** — futuramente vc pode criar um login Grupo VAI com painel admin onde gerencia chaves dos clientes
3. **Cobrar mensalidade** — se for cobrar, integra Stripe + login (a Vercel tem template pronto)
4. **Branding por cliente** — se algum cliente pedir, dá pra criar um deploy separado pra ele com cores próprias

Por enquanto, esse modelo simples é o ideal pro seu volume.

---

© Grupo VAI — RevOps · Soluções WhatsApp Business API
