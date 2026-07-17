-- 리스크가드(자동매매 안전장치) 컬럼 추가. idempotent — 여러 번 실행해도 안전합니다.
-- Supabase 대시보드 > SQL Editor 에서 전체 실행 후, 아래 NOTIFY로 PostgREST 스키마 캐시를 갱신하세요.

alter table public.bnf_trading_settings
  add column if not exists rg_daily_loss_enabled boolean not null default false,
  add column if not exists rg_daily_loss_pct numeric not null default 3,
  add column if not exists rg_circuit_enabled boolean not null default true,
  add column if not exists rg_circuit_drop_pct numeric not null default 5,
  add column if not exists rg_circuit_block_hours numeric not null default 12,
  add column if not exists rg_circuit_until timestamptz,
  add column if not exists rg_streak_enabled boolean not null default false,
  add column if not exists rg_streak_losses int not null default 3,
  add column if not exists rg_streak_block_hours numeric not null default 24,
  add column if not exists rg_symbol_cooldown_enabled boolean not null default true,
  add column if not exists rg_symbol_cooldown_hours numeric not null default 24,
  add column if not exists rg_bear_major_liquidate boolean not null default false;

alter table public.bnf_trading_strategies
  add column if not exists regime_filter_enabled boolean not null default true;

NOTIFY pgrst, 'reload schema';

-- 확인용
select user_id, rg_daily_loss_enabled, rg_circuit_enabled, rg_streak_enabled, rg_symbol_cooldown_enabled, rg_bear_major_liquidate
from public.bnf_trading_settings limit 5;
