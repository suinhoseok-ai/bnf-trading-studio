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
  ('bnf1', 'BNF 전략1 · 볼린저밴드 수렴 회귀',
   '15분봉 기준 볼린저밴드(20, 2σ) 밴드폭 수렴 구간에서 하단밴드 하향 이탈 시 매수. 중심선 도달 시 50% 익절 후 손절가 본절 이동, 상단밴드 도달 시 전량 익절. 1:2 손익비 초기 손절.',
   true,
   '{"period":20,"stddev":2,"bwLookback":100,"bwPercentile":25,"riskReward":2,"positionPct":10}'::jsonb),
  ('breakout', '전략2 · 추세 돌파 + 거래량 급증',
   '일봉 기준 60일 최고가를 거래량 2.5배 급증과 함께 상향 돌파 시 매수. 돌파캔들 저가 손절, EMA20 하향 이탈 시 추세 청산.',
   true,
   '{"resPeriod":60,"volMaPeriod":20,"volMult":2.5,"emaPeriod":20,"positionPct":20}'::jsonb),
  ('pullback', '전략3 · EMA 눌림목 모멘텀',
   '일봉 정배열(EMA20>EMA60) 추세에서 EMA20 눌림목 + 스토캐스틱 골든크로스 매수. EMA20 -3% 손절, 과매수/시간(7영업일) 청산.',
   true,
   '{"emaShort":20,"emaLong":60,"stochK":14,"stochSmooth":3,"maxDays":7,"positionPct":20}'::jsonb),
  ('alignment', '전략4 · 이동평균선 정배열',
   '일봉 5>20>60>120 완전 정배열 전환 초입 매수(이격도 108 이하). 120일선 -2% 손절, 20일선 이탈 50% 익절, 데드크로스/60일선 이탈 전량 청산.',
   true,
   '{"ma1":5,"ma2":20,"ma3":60,"ma4":120,"disparityLimit":108,"positionPct":30}'::jsonb),
  ('box', '전략5 · 박스권 돌파',
   '일봉 기준 높이 15% 이내 조밀 박스권 상단을 거래량 1.5배와 함께 돌파 시 매수. 박스 중간값 손절, EMA20 이탈 청산.',
   true,
   '{"boxPeriod":20,"maxHeight":15,"volMult":1.5,"emaPeriod":20,"positionPct":25}'::jsonb),
  ('rebound', '전략6 · 과매도 반등 + 시장 필터',
   '하락장(KOSPI<200일선) 전용 역추세: 종가가 5일선 아래 + RSI(2) 10 이하 극단 과매도 시 매수. 5일선 회복 익절, 최대 5영업일 시간 청산.',
   true,
   '{"rsiPeriod":2,"rsiThresh":10,"smaPeriod":5,"indexSma":200,"maxDays":5,"positionPct":20}'::jsonb),
  ('disparity', '전략7 · 25일 EMA 이격도 낙주',
   '종가가 25 EMA 대비 과도 하락 이격 + 지지선 근접 + RSI(14) 30 이하 + MACD 히스토그램 상향 반전 시 낙주 매수. 지지선 이탈 손절, 1:2 손익비 익절.',
   true,
   '{"emaPeriod":25,"rsiPeriod":14,"rsiThresh":30,"bullDisparity":20,"bearDisparity":30,"supportLookback":40,"riskReward":2,"positionPct":20}'::jsonb)
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

-- ------------------------------------------------------------
-- 6.5 수동 등록 포지션 (실보유 · 매도 시그널 텔레그램 알림용)
-- ------------------------------------------------------------
create table if not exists public.bnf_user_positions (
  id bigserial primary key,
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  symbol text not null,
  name text default '',
  strategy_code text not null default 'bnf1',
  entry_price numeric not null,
  shares numeric not null,
  alert_enabled boolean not null default true,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

-- ------------------------------------------------------------
-- 6.7 자동매매 (실거래) — Broker Adapter 기반
-- ------------------------------------------------------------
-- 사용자별 자동매매 설정 (증권사 API 키는 서버에서 AES-GCM 암호화되어 저장됨)
create table if not exists public.bnf_trading_settings (
  user_id uuid primary key references public.bnf_profiles(id) on delete cascade,
  broker text not null default 'kis' check (broker in ('kis', 'toss')),
  mode text not null default 'paper' check (mode in ('paper', 'real')),   -- paper=모의투자, real=실전
  app_key text default '',        -- 암호화 저장 (enc: / plain: 접두사)
  app_secret text default '',     -- 암호화 저장
  account_no text default '',     -- 계좌번호 앞 8자리
  account_product_cd text default '01',  -- 계좌상품코드 뒤 2자리
  enabled boolean not null default false,
  status text not null default 'STOPPED' check (status in ('RUNNING', 'PAUSED', 'STOPPED', 'ERROR')),
  strategy_code text not null default 'bnf1',
  universe text not null default 'KOSPI',
  interval_min int not null default 10,
  max_positions int not null default 5,
  budget_pct numeric not null default 10,   -- 매수 1회당 주문가능현금 대비 비중(%)
  token jsonb default '{}'::jsonb,          -- 브로커 액세스 토큰 캐시
  last_run_at timestamptz,
  last_error text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 사용자별 자동매매 전략 예산 (다중 전략 동시 실행 — 전략별 원화 절대금액 한도)
create table if not exists public.bnf_trading_strategies (
  id bigserial primary key,
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  strategy_code text not null,
  budget numeric not null default 0,      -- 전략별 총 투자한도 (원화 절대금액)
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, strategy_code)
);

-- 자동매매 전략 포지션 상태 (전략 청산 로직용 — 실계좌 잔고와 별개로 sl/tp1 상태 추적)
create table if not exists public.bnf_live_positions (
  id bigserial primary key,
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  broker text not null default 'kis',
  symbol text not null,
  name text default '',
  strategy_code text not null default 'bnf1',
  entry_price numeric not null,
  shares numeric not null,
  sl numeric not null default 0,
  tp1_hit boolean not null default false,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  order_no text default '',
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

-- 자동매매 거래 이력 (모든 주문·체결 기록, 삭제하지 않음)
create table if not exists public.bnf_live_trades (
  id bigserial primary key,
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  broker text not null default 'kis',
  mode text not null default 'paper',
  symbol text not null,
  name text default '',
  strategy_code text default '',
  side text not null,             -- BUY / SELL_TP1 / SELL_TP2 / SELL_SL / FORCE_SELL
  trigger_note text default '',   -- 트리거 설명 (전략 신호 내용)
  order_type text not null default 'market',
  order_price numeric default 0,
  qty numeric not null,
  pnl numeric default 0,
  order_no text default '',
  status text not null default 'SUBMITTED',  -- SUBMITTED / FAILED
  executed_at timestamptz not null default now()
);

-- 자동매매 로그 (트리거/주문/응답/오류 — 삭제하지 않음)
create table if not exists public.bnf_trade_logs (
  id bigserial primary key,
  user_id uuid not null references public.bnf_profiles(id) on delete cascade,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  event text not null,
  detail text default '',
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 7. 관리자 전역 설정 (일일 이메일 스캔 리포트 등) — 단일 행
-- ------------------------------------------------------------
create table if not exists public.bnf_admin_config (
  id int primary key default 1,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint bnf_admin_config_singleton check (id = 1)
);
insert into public.bnf_admin_config (id, config) values (1, '{}'::jsonb) on conflict (id) do nothing;

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
alter table public.bnf_user_positions enable row level security;
alter table public.bnf_trading_settings enable row level security;
alter table public.bnf_trading_strategies enable row level security;
alter table public.bnf_live_positions enable row level security;
alter table public.bnf_live_trades enable row level security;
alter table public.bnf_trade_logs enable row level security;
alter table public.bnf_admin_config enable row level security;

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

drop policy if exists "user_positions_own" on public.bnf_user_positions;
create policy "user_positions_own" on public.bnf_user_positions
  for all using (user_id = auth.uid() or public.is_admin());

drop policy if exists "trading_settings_own" on public.bnf_trading_settings;
create policy "trading_settings_own" on public.bnf_trading_settings
  for all using (user_id = auth.uid() or public.is_admin());

drop policy if exists "trading_strategies_own" on public.bnf_trading_strategies;
create policy "trading_strategies_own" on public.bnf_trading_strategies
  for all using (user_id = auth.uid() or public.is_admin());

drop policy if exists "live_positions_own" on public.bnf_live_positions;
create policy "live_positions_own" on public.bnf_live_positions
  for all using (user_id = auth.uid() or public.is_admin());

drop policy if exists "live_trades_own" on public.bnf_live_trades;
create policy "live_trades_own" on public.bnf_live_trades
  for all using (user_id = auth.uid() or public.is_admin());

drop policy if exists "trade_logs_own" on public.bnf_trade_logs;
create policy "trade_logs_own" on public.bnf_trade_logs
  for all using (user_id = auth.uid() or public.is_admin());

-- bnf_admin_config: 로그인 사용자 조회, 관리자만 변경
drop policy if exists "admin_config_select" on public.bnf_admin_config;
create policy "admin_config_select" on public.bnf_admin_config
  for select using (auth.uid() is not null);
drop policy if exists "admin_config_admin" on public.bnf_admin_config;
create policy "admin_config_admin" on public.bnf_admin_config
  for all using (public.is_admin());
