-- ============================================================
-- BNF Trading Studio (AI Edition) — Supabase 스키마
-- Supabase SQL Editor 에 전체를 붙여넣고 실행하세요.
--
-- 모든 테이블은 "bnf_" 접두사를 사용합니다.
-- ============================================================

-- ------------------------------------------------------------
-- 1. 사용자 프로필 (회원승인 / 역할 관리)
-- ------------------------------------------------------------
create table if not exists public.bnf_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text default '',
  role text not null default 'user' check (role in ('user', 'admin')),
  approved boolean not null default false,
  settings jsonb not null default '{}'::jsonb,   -- 사용자별 설정 (Ollama URL, 모델 등)
  created_at timestamptz not null default now()
);

-- 관리자 여부 확인 함수 (RLS 재귀 방지를 위해 security definer)
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.bnf_profiles
    where id = auth.uid() and role = 'admin' and approved = true
  );
$$;

-- 회원가입 시 프로필 자동 생성 (최초 가입자는 자동으로 관리자 + 승인)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  cnt int;
begin
  select count(*) into cnt from public.bnf_profiles;
  insert into public.bnf_profiles (id, email, name, role, approved)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    case when cnt = 0 then 'admin' else 'user' end,
    cnt = 0
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 2. 전략 마스터 (관리자가 전략별 사용유무 토글)
-- ------------------------------------------------------------
create table if not exists public.bnf_strategies (
  id serial primary key,
  code text unique not null,
  name text not null,
  description text default '',
  enabled boolean not null default true,   -- 전역 사용유무
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into public.bnf_strategies (code, name, description, enabled, params) values
  ('bnf1', 'BNF 전략1 (볼린저밴드 수렴 회귀)',
   '15분봉 기준 볼린저밴드(20, 2σ) 밴드폭 수렴 구간에서 하단밴드 하향 이탈 시 매수. 중심선 도달 시 50% 익절 후 손절가 본절 이동, 상단밴드 도달 시 전량 익절. 1:2 손익비 초기 손절.',
   true,
   '{"period":20,"stddev":2,"bwLookback":100,"bwPercentile":25,"riskReward":2,"positionPct":10}'::jsonb)
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- 3. 사용자별 전략 사용권한 (관리자가 개별 부여/차단)
-- ------------------------------------------------------------
create table if not exists public.bnf_user_strategy_access (
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  strategy_id int not null references public.bnf_strategies(id) on delete cascade,
  enabled boolean not null default true,
  primary key (user_id, strategy_id)
);

-- ------------------------------------------------------------
-- 4. 관심종목
-- ------------------------------------------------------------
create table if not exists public.bnf_watchlist (
  id bigserial primary key,
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  symbol text not null,
  name text default '',
  created_at timestamptz not null default now(),
  unique (user_id, symbol)
);

-- ------------------------------------------------------------
-- 5. 모의투자 (가상계좌 / 보유포지션 / 거래내역)
-- ------------------------------------------------------------
create table if not exists public.bnf_paper_accounts (
  user_id uuid primary key references public.bnf_profiles(id) on delete cascade,
  initial_balance numeric not null default 10000000,
  cash numeric not null default 10000000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bnf_paper_positions (
  id bigserial primary key,
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  symbol text not null,
  name text default '',
  strategy_code text not null default 'bnf1',
  entry_price numeric not null,
  shares numeric not null,
  sl numeric not null,
  tp1_hit boolean not null default false,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.bnf_paper_trades (
  id bigserial primary key,
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  symbol text not null,
  name text default '',
  strategy_code text not null default 'bnf1',
  side text not null check (side in ('BUY', 'SELL_TP1', 'SELL_TP2', 'SELL_SL', 'SELL_MANUAL')),
  price numeric not null,
  shares numeric not null,
  pnl numeric default 0,
  note text default '',
  executed_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 6. 백테스트 결과 저장
-- ------------------------------------------------------------
create table if not exists public.bnf_backtest_results (
  id bigserial primary key,
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  symbol text not null,
  name text default '',
  strategy_code text not null default 'bnf1',
  interval text not null default '1d',
  range_label text default '',
  initial_balance numeric not null default 10000000,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- RLS (Row Level Security) — 사용자별 데이터 격리 + 관리자 전체 접근
-- ============================================================
alter table public.bnf_profiles enable row level security;
alter table public.bnf_strategies enable row level security;
alter table public.bnf_user_strategy_access enable row level security;
alter table public.bnf_watchlist enable row level security;
alter table public.bnf_paper_accounts enable row level security;
alter table public.bnf_paper_positions enable row level security;
alter table public.bnf_paper_trades enable row level security;
alter table public.bnf_backtest_results enable row level security;

-- bnf_profiles: 본인 조회/수정(settings), 관리자 전체 조회/수정
drop policy if exists "profiles_select_own" on public.bnf_profiles;
create policy "profiles_select_own" on public.bnf_profiles
  for select using (id = auth.uid() or public.is_admin());
drop policy if exists "profiles_update_own" on public.bnf_profiles;
create policy "profiles_update_own" on public.bnf_profiles
  for update using (id = auth.uid() or public.is_admin());

-- bnf_strategies: 로그인 사용자 전체 조회, 관리자만 변경
drop policy if exists "strategies_select" on public.bnf_strategies;
create policy "strategies_select" on public.bnf_strategies
  for select using (auth.uid() is not null);
drop policy if exists "strategies_admin_all" on public.bnf_strategies;
create policy "strategies_admin_all" on public.bnf_strategies
  for all using (public.is_admin());

-- bnf_user_strategy_access: 본인 조회, 관리자 전체 관리
drop policy if exists "usa_select_own" on public.bnf_user_strategy_access;
create policy "usa_select_own" on public.bnf_user_strategy_access
  for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "usa_admin_all" on public.bnf_user_strategy_access;
create policy "usa_admin_all" on public.bnf_user_strategy_access
  for all using (public.is_admin());

-- 사용자 소유 테이블 공통 정책
drop policy if exists "watchlist_own" on public.bnf_watchlist;
create policy "watchlist_own" on public.bnf_watchlist
  for all using (user_id = auth.uid() or public.is_admin());

drop policy if exists "paper_accounts_own" on public.bnf_paper_accounts;
create policy "paper_accounts_own" on public.bnf_paper_accounts
  for all using (user_id = auth.uid() or public.is_admin());

drop policy if exists "paper_positions_own" on public.bnf_paper_positions;
create policy "paper_positions_own" on public.bnf_paper_positions
  for all using (user_id = auth.uid() or public.is_admin());

drop policy if exists "paper_trades_own" on public.bnf_paper_trades;
create policy "paper_trades_own" on public.bnf_paper_trades
  for all using (user_id = auth.uid() or public.is_admin());

drop policy if exists "backtest_results_own" on public.bnf_backtest_results;
create policy "backtest_results_own" on public.bnf_backtest_results
  for all using (user_id = auth.uid() or public.is_admin());
