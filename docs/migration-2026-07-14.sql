-- 이번 세션(시장국면 엔진 + 9전략 업그레이드)에서 추가된 마이그레이션만 모은 파일.
-- 이미 실행된 부분은 idempotent(IF NOT EXISTS / ON CONFLICT DO NOTHING)하게 작성되어
-- 여러 번 실행해도 안전합니다. Supabase 대시보드 > SQL Editor에서 전체를 실행하세요.

-- ── 1) 신규 전략 2개(openbrk, rangeswing) 등록 ──
insert into public.bnf_strategies (code, name, description, enabled, params) values
  ('openbrk', '전략8 · (상승) 시가돌파 단타',
   '15분봉 근사: 전일 양봉·거래량 급증 종목이 장 초반 시가를 1% 상향 돌파하고 VWAP 위·거래량 급증 시 매수. +2%/+4% 분할익절 후 VWAP 이탈 잔량 청산, 15:20 이후 강제 전량 청산.',
   true,
   '{"entryWindowBars":6,"openBreakPct":1,"volZEntryMin":2.0,"prevDayVolZMin":1.5,"gapMin":-1,"gapMax":3,"slOpenPct":1.5,"tp1":2,"tp2":4,"positionPct":8}'::jsonb),
  ('rangeswing', '전략9 · (횡보) 박스권 스윙',
   '일봉 기준 최근 25일 박스(폭 6~18%, 상하단 각 2회 이상 터치, 삼각수렴 제외) 하단 근접 + 거래량 감소 + 반등캔들 + RSI 30~50 + Slow Stoch 골든크로스 + CCI -100 회복 시 매수. 박스 중앙/상단 분할익절 후 돌파 시 ATR 트레일, 5일 시간청산.',
   true,
   '{"boxPeriod":25,"boxWidthMin":6,"boxWidthMax":18,"touchBand":1.5,"touchMin":2,"nearBottomPct":2,"rsiLo":30,"rsiHi":50,"maxDays":5,"positionPct":15}'::jsonb)
on conflict (code) do nothing;

-- ── 2) 기존 6개 전략의 이름/설명/파라미터 최신 스펙으로 갱신 ──
update public.bnf_strategies set
  name = '전략2 · (상승) 추세추종 · 신고가 돌파',
  description = '일봉 정배열 상태에서 60일(또는 ADX≥30 시 20일) 신고가를 거래량 Z≥2·짧은 윗꼬리·RS우위·OBV상승과 함께 돌파 시 매수. +8% 도달 후 10일선 이탈 50% 익절, 잔여 ATR 트레일/60일선 이탈 전량 청산.',
  params = '{"ma1":20,"ma2":60,"ma3":120,"resLong":60,"resShort":20,"adxShortMin":30,"volZMin":2.0,"positionPct":20}'::jsonb
where code = 'breakout';
update public.bnf_strategies set
  name = '전략3 · (상승) 눌림목 스윙',
  description = '일봉 정배열(MA5>MA20>MA60)에서 20일 고점 대비 3~8% 건강한 조정(거래량 감소) 후 거래량 급증 반등캔들 + RSI 45~65 + MACD 개선 시 매수. 분할익절(+5%/+8%) 후 MA5 이탈 잔량 청산, 7일 시간청산.',
  params = '{"ma1":5,"ma2":20,"ma3":60,"pullbackMin":3,"pullbackMax":8,"rsiLo":45,"rsiHi":65,"maxDays":7,"positionPct":20}'::jsonb
where code = 'pullback';
update public.bnf_strategies set
  description = '일봉 5>20>60>120 완전 정배열 완성 후 3봉 이내 초입 매수(이격도·ADX·거래량 필터). 20일선 이탈 50% 익절, 데드크로스/60일선 이탈 전량 청산.',
  params = '{"ma1":5,"ma2":20,"ma3":60,"ma4":120,"disparityLimit":108,"adxMin":20,"entryWindowBars":3,"positionPct":30}'::jsonb
where code = 'alignment';
update public.bnf_strategies set
  description = '일봉 기준 높이 15% 이내 조밀 박스권 상단을 거래량 Z-score 2 이상·짧은 윗꼬리와 함께 돌파 시 매수. 박스 상단 -1% 재이탈 손절, EMA20 이탈 청산.',
  params = '{"boxPeriod":20,"maxHeight":15,"volZMin":2.0,"emaPeriod":20,"slBreakoutBuffer":1,"positionPct":25}'::jsonb
where code = 'box';
update public.bnf_strategies set
  name = '전략6 · (하락) 과매도 반등',
  description = '일봉 기준 5일 -8%/10일 -12% 급락 + RSI(14)≤25 + 볼린저 하단 이탈 후 재진입 + 거래량 Z≥2.5(투매) + 반등캔들 시 매수. 분할익절(+2.5%/+5%) 후 MA5 이탈 잔량 청산, 2거래일 무조건 전량 시간청산.',
  params = '{"drop5":8,"drop10":12,"rsiMax":25,"volZMin":2.5,"slPct":2.5,"tp1":2.5,"tp2":5,"maxDays":2,"positionPct":10}'::jsonb
where code = 'rebound';
update public.bnf_strategies set
  name = '전략7 · (하락) 낙폭과대 반등',
  description = '5일 -15%/10일 -20% 낙폭과대 + MA60×0.8 또는 EMA25×0.85 이하 이격 + RSI 20~35 + 볼린저 재진입 + CCI -200→-100 회복 + Slow Stoch 골든크로스 시 매수. 분할익절(+5%/+8%) 후 +12% 또는 MA20 접근 시 전량, 5거래일 시간청산.',
  params = '{"drop5":15,"drop10":20,"ma60Ratio":0.80,"ema25Ratio":0.85,"rsiLo":20,"rsiHi":35,"maxDays":5,"positionPct":15}'::jsonb
where code = 'disparity';

-- ── 3) sort_order / regime 컬럼 추가 + 9전략 백필 (관리자 화면 드래그 정렬 + 장세 뱃지의 기반) ──
alter table public.bnf_strategies
  add column if not exists sort_order int not null default 100,
  add column if not exists regime text not null default 'ANY' check (regime in ('BULL', 'SIDEWAYS', 'BEAR', 'ANY'));

update public.bnf_strategies set sort_order = 10, regime = 'SIDEWAYS' where code = 'bnf1';
update public.bnf_strategies set sort_order = 20, regime = 'BULL' where code = 'breakout';
update public.bnf_strategies set sort_order = 30, regime = 'BULL' where code = 'pullback';
update public.bnf_strategies set sort_order = 40, regime = 'BULL' where code = 'alignment';
update public.bnf_strategies set sort_order = 50, regime = 'SIDEWAYS' where code = 'box';
update public.bnf_strategies set sort_order = 60, regime = 'BEAR' where code = 'rebound';
update public.bnf_strategies set sort_order = 70, regime = 'BEAR' where code = 'disparity';
update public.bnf_strategies set sort_order = 80, regime = 'BULL' where code = 'openbrk';
update public.bnf_strategies set sort_order = 90, regime = 'SIDEWAYS' where code = 'rangeswing';

-- ── 4) 시장국면 판정 이력 테이블 (대시보드 시장현황 카드 + regime.mts 스케줄 함수용) ──
create table if not exists public.bnf_market_regime (
  id bigserial primary key,
  judged_at timestamptz not null default now(),
  session text not null check (session in ('preopen', 'midday', 'close')),
  trade_date date not null,
  kospi_regime text not null check (kospi_regime in ('BULL', 'SIDEWAYS', 'BEAR')),
  kosdaq_regime text not null check (kosdaq_regime in ('BULL', 'SIDEWAYS', 'BEAR')),
  detail jsonb not null default '{}'::jsonb,
  unique (trade_date, session)
);
alter table public.bnf_market_regime enable row level security;
drop policy if exists "market_regime_select" on public.bnf_market_regime;
create policy "market_regime_select" on public.bnf_market_regime
  for select using (auth.uid() is not null);

-- ── 확인용: 9개 전략이 모두 보이는지, sort_order/regime이 채워졌는지 체크 ──
select code, name, sort_order, regime, enabled from public.bnf_strategies order by sort_order;
