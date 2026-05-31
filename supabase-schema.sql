-- ============================================================
-- SCHEMA: Painel BI Grupo VAI — Kill Switch de Inadimplência
-- ============================================================
-- Cole este script no SQL Editor do Supabase (Database > SQL Editor > New query)
-- e clique em RUN. Cria a tabela `clients` e os índices necessários.
-- ============================================================

-- Tabela de clientes autorizados a usar o Painel BI
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  empresa     text not null,
  api_key     text not null unique,
  is_active   boolean not null default true,
  created_at  timestamp with time zone not null default now()
);

-- Índice explícito pra busca rápida pela api_key (usado no kill switch)
create index if not exists idx_clients_api_key on public.clients(api_key);

-- Comentários de documentação (opcional, ajuda no painel do Supabase)
comment on table  public.clients              is 'Clientes autorizados a usar o Painel BI Grupo VAI';
comment on column public.clients.empresa      is 'Nome do cliente / empresa (apenas pra organização interna)';
comment on column public.clients.api_key      is 'Chave da API DataCrazy que o cliente cola no painel';
comment on column public.clients.is_active    is 'KILL SWITCH — se false, bloqueia acesso imediatamente';
comment on column public.clients.created_at   is 'Data de cadastro do cliente';

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
-- Como vamos acessar a tabela APENAS via service_role (do backend Vercel),
-- a abordagem mais simples é deixar RLS DESATIVADO para esta tabela.
-- O service_role bypassa RLS por padrão.
--
-- Se quiser ativar RLS por defesa em profundidade, descomente as 2 linhas:
-- alter table public.clients enable row level security;
-- create policy "service_role acessa tudo" on public.clients for all to service_role using (true);

-- ============================================================
-- EXEMPLOS DE USO (operações manuais via SQL Editor)
-- ============================================================

-- CADASTRAR um novo cliente:
-- insert into public.clients (empresa, api_key, is_active) values
--   ('PlayFit',         'dc_eyJhbGc...chave_real_do_cliente', true),
--   ('Cliente Beta',    'dc_eyJhbGc...outra_chave', true);

-- LISTAR todos os clientes:
-- select empresa, is_active, created_at from public.clients order by created_at desc;

-- KILL SWITCH (suspender acesso por inadimplência):
-- update public.clients set is_active = false where empresa = 'PlayFit';

-- REATIVAR acesso (após pagamento):
-- update public.clients set is_active = true where empresa = 'PlayFit';

-- REMOVER cliente permanentemente:
-- delete from public.clients where empresa = 'Cliente que pediu cancelamento';
