-- 시장국면 엔진 v2 (3국면 → 5국면+전환구간) 마이그레이션. idempotent — 여러 번 실행해도 안전합니다.
-- Supabase 대시보드 > SQL Editor 에서 전체 실행 후, 맨 아래 NOTIFY로 PostgREST 스키마 캐시를 갱신하세요.

-- 1) bnf_market_regime: 3값 → 6값 체크 + 확정/후보/신뢰도/streak/risk_state 컬럼
alter table public.bnf_market_regime
  drop constraint if exists bnf_market_regime_kospi_regime_check,
  drop constraint if exists bnf_market_regime_kosdaq_regime_check;

-- 기존 SIDEWAYS 데이터 → RANGE 로 이관 (candidate 컬럼은 추가 후 별도 처리)
update public.bnf_market_regime set kospi_regime = 'RANGE' where kospi_regime = 'SIDEWAYS';
update public.bnf_market_regime set kosdaq_regime = 'RANGE' where kosdaq_regime = 'SIDEWAYS';

alter table public.bnf_market_regime
  add column if not exists kospi_candidate text,
  add column if not exists kosdaq_candidate text,
  add column if not exists confidence numeric,
  add column if not exists confirmation_streak int not null default 0,
  add column if not exists risk_state text not null default 'NORMAL';

alter table public.bnf_market_regime
  add constraint bnf_market_regime_kospi_regime_check
    check (kospi_regime in ('BULL_MAJOR','BULL','RANGE','BEAR','BEAR_MAJOR','TRANSITION')),
  add constraint bnf_market_regime_kosdaq_regime_check
    check (kosdaq_regime in ('BULL_MAJOR','BULL','RANGE','BEAR','BEAR_MAJOR','TRANSITION'));

-- 2) bnf_trading_settings: 대세하락장 자동청산 중복 방지 컬럼
alter table public.bnf_trading_settings
  add column if not exists rg_last_liquidated_date date;

NOTIFY pgrst, 'reload schema';

-- 확인용
select trade_date, session, kospi_regime, kospi_candidate, confidence, confirmation_streak, risk_state
from public.bnf_market_regime order by judged_at desc limit 5;
