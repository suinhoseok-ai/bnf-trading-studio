# BNF Trading Studio — 개발 인계 문서 (HANDOFF)

> **이 문서의 목적**: 다른 채팅 세션(새 Claude Code 창)에서 이 프로젝트 개발을 그대로 이어받기 위한 단일 진입점 문서입니다.
> 새 세션은 **이 파일 + 이 폴더(`C:\02.클로드\01.테스트\98.BNF`) 권한**만 있으면 전체 맥락을 파악하고 작업을 계속할 수 있습니다.
> 작성 기준일: 2026-07-11 · 현재 HEAD: `6247341` (Add live auto-trading with broker adapters, strategy 7, and UI customization)

---

## 0. 새 세션 온보딩 (여기부터 읽으세요)

1. 이 문서를 끝까지 읽는다.
2. `README.md`(사용자용 기능/배포 안내)와 `supabase/schema.sql`(DB 전체)을 읽는다.
3. 아래 **"작업 워크플로"** 대로 빌드→검증→커밋한다.
4. 배포는 **사용자가 명시적으로 요청할 때만** 한다 (`git push` = 자동 배포 트리거).
5. `.env`는 **절대 커밋하지 않는다** (Supabase URL/anon key 포함. `.gitignore`에 등록됨).

프로젝트 관리자(Git): `SuinHoseok` / 사용자 이메일: `suinhoseok@gmail.com`
GitHub 원격: `https://github.com/suinhoseok-ai/bnf-trading-studio.git` (branch: `main`)

---

## 1. 프로젝트 개요

일본 투자자 **BNF의 매매기법**을 모듈화한 **웹 기반 주식 트레이딩 시스템**. 세 개의 층으로 구성:

1. **시뮬레이션** (기존, 변경 금지 원칙): 전략 스캐너 · 차트 분석 · 백테스트 · 모의투자(가상 1,000만원)
2. **알림/리포트**: 텔레그램 실시간 신호 알림 + 이메일 스캔 리포트 (서버 예약 함수)
3. **실거래 자동매매** (최신 추가): Broker Adapter로 한국투자증권 실계좌 자동매매 — 시뮬레이션과 **완전 분리된 독립 모듈**

**핵심 설계 원칙**: 모든 매매 판단은 **전략 엔진의 결정론적 트리거**로만 이루어짐. **AI는 매매에 관여하지 않음** (AI는 차트 해설·요약 용도로만 별도 존재).

---

## 2. 기술 스택

| 영역 | 기술 |
|---|---|
| Frontend | React 18 + Vite 5 + TypeScript 5 + Tailwind CSS 3 (React Router 6) |
| 차트 | TradingView Lightweight Charts 4 |
| DB/인증 | Supabase (PostgreSQL + Auth + RLS) |
| 서버리스 | Netlify Functions (`.mts`, ESM) — 예약함수(cron) + HTTP 함수 |
| 시세 | Yahoo Finance (개발: Vite 프록시 / 배포: `yahoo.mts` 프록시, 실패 시 합성 데모 데이터 폴백) |
| 로컬 AI | Qwen3 via Ollama (`http://localhost:11434`) — 매매 무관, 해설 전용 |
| 배포 | Netlify (GitHub 연동 자동배포) + Cloudflare DNS/CDN |
| 암호화 | node:crypto AES-256-GCM (브로커 API 키 저장) |

빌드 스크립트: `npm run build` = `tsc -b && vite build` (타입체크 포함).

---

## 3. 작업 워크플로 (중요 — 매 작업마다 이 순서)

### 3.1 빌드/타입체크
```bash
cd "/c/02.클로드/01.테스트/98.BNF"
npm run build   # tsc -b 로 타입 에러까지 잡힘. 반드시 통과 확인
```

### 3.2 Netlify 함수 번들 검증 (함수 수정 시)
```bash
# 각 함수가 esbuild로 번들되는지 (import 경로/문법 오류 조기 발견)
for f in broker trader notify report run-report telegram yahoo; do
  npx esbuild netlify/functions/$f.mts --bundle --platform=node --format=esm \
    --outfile=/tmp/fn_$f.mjs --external:@supabase/supabase-js \
    2>&1 | grep -E "error|✘" && echo "FAIL: $f" || echo "OK: $f"
done; rm -f /tmp/fn_*.mjs
```

### 3.3 게스트 모드 브라우저 스모크 테스트 (UI 수정 시)
`.env`를 잠시 비활성화하면 **게스트 데모 모드**(로그인 없이 전 기능, localStorage 저장)로 뜬다. playwright-core + 로컬 Chrome로 확인:
```bash
# 1) .env 잠시 비활성화 → 게스트 모드로 dev 서버 기동
mv .env .env.tmp_disabled
(npm run dev > /tmp/vite_bnf.log 2>&1 &)
sleep 5
# 2) 스모크 스크립트 실행 (스크린샷 저장 + pageerror 수집)
#    참고 스크립트: 스크래치패드의 smoke4.js 패턴 (헤드리스 Chrome, 각 페이지 방문 후 에러 카운트)
#    Chrome 경로: C:\Program Files\Google\Chrome\Application\chrome.exe
# 3) 끝나면 반드시 원복 + 서버 종료
mv .env.tmp_disabled .env
PID=$(netstat -ano 2>/dev/null | grep ':5173' | grep LISTENING | awk '{print $5}' | head -1)
[ -n "$PID" ] && taskkill //PID $PID //F
```
> **주의**: 게스트 모드에서는 자동매매(`/trading`)·리포트 발송·텔레그램은 "로그인 필요" 안내만 표시됨(서버 함수 필요). UI 렌더링·전략 계산·차트·스캐너는 전부 확인 가능.

### 3.4 전략 엔진 정확도 검증 (전략 로직 수정/추가 시)
`ALL_STRATEGIES`를 순회하며 **회계 불변식(finalBalance-initial == Σpnl)**, EMA/SMA 기대값, NaN/Infinity 부재를 검사하는 패턴. esbuild로 번들 후 node 실행:
```bash
# src를 상대경로로 import 하는 verify.ts 작성 → esbuild 번들 → node 실행
npx esbuild verify.tmp.ts --bundle --platform=node --format=cjs --outfile=verify.tmp.cjs
node verify.tmp.cjs; rm -f verify.tmp.ts verify.tmp.cjs
```
- 극단 조건 전략(rebound/disparity)은 랜덤 데이터에서 매수신호 0이 정상 → **의도적 크래시 시나리오**를 합성해 매수→청산까지 검증할 것.
- top-level `await` 금지(CJS 번들). async IIFE로 감쌀 것.

### 3.5 커밋 규칙
- `.env`, `.env.*` 절대 스테이징 금지. `git add`는 **파일 지정 방식** 권장(광범위 `-A` 후 반드시 `git status` 확인).
- 커밋 메시지 끝에 Co-Authored-By 라인 넣지 말 것(이 저장소 기존 커밋은 순수 메시지만 사용).
- 줄바꿈 경고(`LF will be replaced by CRLF`)는 Windows 환경 정상 동작 — 무시.
- **배포(push)는 사용자가 요청할 때만.**

---

## 4. 파일 구조 & 역할

```
98.BNF/
├─ README.md                     # 사용자용 기능/설치/배포 안내
├─ DEVELOPMENT.md                # (이 문서) 개발 인계
├─ netlify.toml                  # 빌드 설정 + /api/* 리다이렉트 + SPA fallback
├─ package.json                  # deps: supabase-js, lightweight-charts, react-router
├─ supabase/schema.sql           # DB 전체: 테이블 + RLS + 회원승인 트리거 + 전략 시드
├─ netlify/functions/            # 서버리스 (.mts, ESM)
│  ├─ yahoo.mts                  #   Yahoo 시세 프록시 (/api/yahoo/*)
│  ├─ telegram.mts               #   텔레그램 발송 프록시 (/api/telegram)
│  ├─ notify.mts                 #   [예약] 텔레그램 신호 알림 (장중, 매수/관심/포지션 매도)
│  ├─ report.mts                 #   [예약] 이메일 스캔 리포트 (일일 + 전체, 매시 정각)
│  ├─ run-report.mts             #   리포트 수동 발송 (/api/run-report, 관리자)
│  ├─ broker.mts                 #   [자동매매] 브로커 HTTP API (/api/broker, 인증)
│  └─ trader.mts                 #   [자동매매·예약] 10분마다 무인 매매 엔진
└─ src/
   ├─ App.tsx                    # 라우트 정의
   ├─ context/AuthContext.tsx    # 세션·프로필·역할·전략권한·guestMode
   ├─ components/                # Layout(사이드바 토글+전체화면), CandleChart, EquityChart, Stars, StrategyPicker
   ├─ hooks/                     # useStrategySelection, useTelegramConfig
   ├─ pages/                     # 아래 "페이지" 표 참고
   └─ lib/
      ├─ types.ts                # 공통 타입 (Candle, Profile, Strategy, TelegramSettings, AdminConfig, UserPosition ...)
      ├─ supabase.ts             # Supabase 클라이언트 + supabaseConfigured 플래그
      ├─ marketData.ts           # 시세수집 + 종목유니버스(KOSPI/KOSDAQ_TOP, ALL_STOCKS, universeStocks, stockName, UNIVERSE_OPTIONS) + fetchQuote/fetchFundamentals
      ├─ market-hours.ts         # kstNow(), isKoreanMarketOpen() (평일 09:00~15:30 KST)
      ├─ indicators.ts           # 볼린저·밴드폭·수렴·RSI 등 (레거시 BNF1용)
      ├─ analysis.ts             # analyzeChart() — 규칙기반(비-AI) 차트 해설
      ├─ scanner.ts / simulator.ts / paper.ts   # 레거시 BNF1 스캐너/백테스트/모의투자 (engine.ts로 대체되며 공존)
      ├─ report-core.ts          # 이메일 리포트 공용 로직 (report.mts + run-report.mts 공유)
      ├─ telegram.ts             # 텔레그램 메시지 포맷터 (fmtWatchMessage, fmtPositionMessage ...)
      ├─ ollama.ts               # Qwen3 연동 (해설 전용)
      ├─ strategies/             # ★ 전략 엔진 (아래 5장)
      └─ broker/                 # ★ 브로커 어댑터 (아래 6장)
```

### 페이지 (`src/pages/`, 라우트는 `src/App.tsx`)
| 경로 | 파일 | 설명 |
|---|---|---|
| `/` | DashboardPage | 지수+대표종목 카드(최대5개 편집), 오늘 신호, 계좌 요약 |
| `/scanner` | ScannerPage | 전략별 조건충족 점수 스캔, "더 보기" 배치 로드 |
| `/stocks` | StocksPage | 전체 종목 목록(84종목) + 검색 + 페이지네이션 + 관심종목 |
| `/report` | ReportPage | 전 전략 × 코스피15+코스닥8 종합 리포트 |
| `/chart` | ChartPage | 캔들차트 + 전략 지표선 + 규칙기반 분석 |
| `/backtest` | BacktestPage | 백테스트 (수익률/MDD/Sharpe/거래로그/자산곡선) |
| `/paper` | PaperPage | 모의투자(가상계좌) 자동 시뮬레이션 |
| `/positions` | PositionsPage | 수동 포지션 등록 + 텔레그램 매도 알림 |
| `/trading` | TradingPage | ★ 자동매매(실거래): 브로커 설정·계좌·포지션·강제매도·거래이력·로그 |
| `/ai` | AIPage | Qwen3 대화 (해설 전용) |
| `/settings` | SettingsPage | Ollama + 텔레그램 설정 |
| `/admin` | AdminPage | 회원승인·역할·전략권한·리포트 설정·수동 발송 |
| `/login`, `/pending` | LoginPage, PendingPage | 로그인 / 승인대기 |

---

## 5. 전략 엔진 (`src/lib/strategies/`)

전략 7종 (레지스트리 `index.ts`의 `STRATEGIES`/`STRATEGY_ORDER`/`ALL_STRATEGIES`/`getStrategy()`):

| code | 이름 | 요약 |
|---|---|---|
| `bnf1` | 볼린저밴드 수렴 회귀 | 15m, 밴드폭 수렴+하단이탈 매수, 중심선 50%익절/상단 전량 |
| `breakout` | 추세돌파+거래량 | 1d, 신고가 돌파 + 거래량 급증 |
| `pullback` | EMA 눌림목 | 1d, 정배열 중 EMA20 눌림. SL=EMA20×0.97 동적 |
| `alignment` | 정배열 | 1d, MA 정배열 진입 / 데드크로스·MA60이탈 청산 |
| `box` | 박스권 돌파 | 1d, 박스 상단 돌파 |
| `rebound` | 과매도 반등+시장필터 | 1d, 하락장(KOSPI<200일선)+RSI2≤10 → 5일선 회복/5일 시간청산 |
| `disparity` | 25EMA 이격도 낙주 (BNF 2번째 기법) | 1d, 25EMA 과대 하락이격+지지선+RSI14≤30+MACD히스토그램 저점반전. SL=지지선이탈, TP=1:2 |

### StrategyModule 인터페이스 (`types.ts`) — 새 전략 추가법
각 전략은 다음을 구현:
- `code, name, short, interval, range, positionPct, params, lineStyles, colHeaders, rules`
- `compute(candles): StratRow[]` — 지표 계산 + `buy`/`exit` 플래그
- `scan(symbol, name, rows): StratScan` — 스캐너 점수(0~100)·별점·컬럼·조건 체크리스트
- `planEntry(rows, i, cash): EntryPlan | null` — 진입가·수량·손절가·트리거설명
- `stepOpen(pos, row): { events: ExitEvent[]; updated }` — 봉 단위 청산 (무상태 재계산)
- (선택) `init(fetch: CandleFetcher)` — 외부 데이터 준비 (rebound/disparity가 KOSPI `^KS11` 200일선 캐시)

**새 전략 추가 체크리스트**:
1. `src/lib/strategies/<code>.ts` 작성 (기존 전략 파일 참고)
2. `index.ts`에 import + `STRATEGIES`/`STRATEGY_ORDER` 등록
3. `supabase/schema.sql`의 전략 시드 INSERT에 추가 (`on conflict do nothing`)
4. **`compute()` 전 반드시 init 호출**: 클라이언트 `initStrategy(mod)`, 서버 `await mod.init?.(fetchCandlesServer)`
5. 3.4 검증 실행

**공용 엔진** `engine.ts`: `simulate()`(백테스트), `manageOpen()`(모의투자), 지표 헬퍼(`emaArr`, `smaAt`, `minOfPrev`, `rsiSimple`, `calcShares`, `starsFromScore`).

> **disparity 구현 주의**: 명세서 원문의 "MACD 히스토그램 0선 상향 교차"는 급락 후 가격이 이미 회복된 뒤에야 발생하여 과매도(이격도·RSI) 조건과 **동시 성립이 불가능**하다(디버그로 확인). 따라서 "히스토그램 골 전환(저점에서 상승 반전)"으로 해석·구현함. 시장국면도 명세서 스켈레톤의 종목 자체 200SMA(임시구현) 대신 **KOSPI 지수 200일선**을 사용(종목 급락이 자기 기준을 더 엄격하게 만드는 모순 제거).

---

## 6. 자동매매 (실거래) 아키텍처

시뮬레이션과 **완전 분리**. 개발 원칙(명세서): 기존 시뮬레이션 변경 금지 / 독립 모듈 / Broker Adapter 패턴 / 전략·주문 로직 분리 / AI 미사용.

### 6.1 Broker Adapter (`src/lib/broker/`, 서버 전용 — node:crypto 사용)
- `types.ts` — `BrokerAdapter` 인터페이스(connect/getAccount/getPositions/getOrders/getMarketPrice/placeBuyOrder/placeSellOrder/cancelOrder), `toKrCode()`(005930.KS→005930)
- `kis.ts` — **한국투자증권 완전 구현**. 실전 `openapi.koreainvestment.com:9443` / 모의 `openapivts:29443`. tr_id 실전·모의 매핑. 토큰 1분당 1회 발급 제한 → `bnf_trading_settings.token` jsonb 캐시(persist 콜백)
- `toss.ts` — **토스증권 스텁**. 개인용 공개 매매 API 미제공 → 전 메서드 `BrokerError`. API 공개 시 이 파일만 교체하면 됨(엔진/UI 수정 불필요)
- `index.ts` — `getAdapter()` 팩토리 + API 키 암호화(`encryptSecret`/`decryptSecret`, AES-256-GCM, `BROKER_ENC_KEY` 기반. 미설정 시 `plain:` base64 폴백 + UI 경고), `maskKey()`

### 6.2 무인 실행 엔진 `trader.mts` (예약함수 `*/10 * * * *`)
브라우저 불필요. 장중(`isKoreanMarketOpen`)에만. **전략 카드(`bnf_trading_strategies`) 단위로 완전히 독립 실행** — `status='RUNNING'`인 카드가 1개 이상 있는 사용자만 처리:
1. Broker connect (토큰 캐시, 전략 카드들이 공유)
2. **매도**: `bnf_live_positions`(OPEN) 전체 → 각 포지션의 `strategy_code`로 전략 모듈 조회 → `stepOpen` 트리거 → 시장가 매도 (거래소 매도가능수량 범위 내). 카드가 중지/삭제되어도 기존 보유 포지션은 계속 관리됨.
3. **매수**: `status='RUNNING' & budget>0`인 카드를 순회. **각 카드는 자기만의 `universe`(스캔대상)·`interval_min`(실행주기, 자체 `last_run_at`으로 스로틀링)·`max_positions`(그 전략코드의 현재 OPEN 포지션 수 기준)·`budget`을 가진 완전 독립 단위**:
   - 잔여예산 = `strategy.budget − Σ(entry_price×shares)` (해당 전략의 현재 OPEN 포지션 투입액)
   - 유니버스(상한 25종목) 스캔 → `buy` 트리거 종목들을 `scan()` 점수(0~100)와 함께 수집
   - 같은 회차에 잡힌 신호가 여럿이면 잔여예산을 **점수 비중으로 분배**(`alloc = 잔여예산 × score/Σscore`, 실제 계좌현금 상한 적용) 후 각각 시장가 매수 (전체 회당 최대 5건)
   - 처리 후 해당 카드의 `last_run_at`/`status`(오류 시 `ERROR`+`last_error`)를 개별 기록 — 한 카드의 오류가 다른 카드 처리를 막지 않음(카드별 try/catch)
4. `bnf_live_trades`(거래이력) + `bnf_trade_logs`(로그) 저장, 텔레그램 알림

### 6.3 웹 API `broker.mts` (`POST /api/broker`, accessToken 검증)
actions: `save-settings`(브로커/계좌 필드만, 키 암호화 저장) / `get-settings`(키 마스킹, 전략 카드 전체 목록 `strategies` 포함) / `test`(연결+계좌) / `account` / `positions` / `orders` / `force-sell`(강제매도) / **`save-strategy`**(카드 저장, `id` 있으면 update 없으면 insert) / **`toggle-strategy`**(카드 개별 시작·중지, 시작 시 연결 검증) / **`delete-strategy`**(카드 삭제, 포지션은 유지). UI = `TradingPage.tsx`(전략 카드형 레이아웃 — 카드마다 매매전략·스캔대상·실행주기·최대보유수·예산·시작/중지/저장/삭제).

---

## 7. 환경변수

### 클라이언트 (`.env`, `VITE_` 접두사 — 빌드 시 번들, 공개됨)
| 키 | 용도 |
|---|---|
| `VITE_SUPABASE_URL` | Supabase 프로젝트 URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon 공개키 |
| `VITE_OLLAMA_URL` | 기본 Ollama URL (`http://localhost:11434`) |
| `VITE_OLLAMA_MODEL` | 기본 모델 (`qwen3:8b`) |

> `.env` 없으면 게스트 데모 모드. **절대 커밋 금지**.

### 서버 (Netlify 환경변수 — 비공개, 함수에서 `process.env`로 접근)
| 키 | 용도 | 필요 함수 |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | RLS 우회 서버 접근 (**최고 민감**) | notify, report, run-report, broker, trader |
| `SUPABASE_URL` | (선택) 없으면 `VITE_SUPABASE_URL` 폴백 | 위 전부 |
| `RESEND_API_KEY` | 이메일 발송 (resend.com) | report, run-report |
| `RESEND_FROM` | (선택) 발신주소, 기본 `onboarding@resend.dev` | report, run-report |
| `BROKER_ENC_KEY` | 브로커 API 키 암호화 (임의 긴 문자열, **권장**) | broker, trader |

---

## 8. DB 스키마 (`supabase/schema.sql`)

RLS 전부 활성. 대부분 `user_id = auth.uid() or is_admin()` 정책. 최초 가입자 자동 admin+승인(트리거).

| 테이블 | 용도 |
|---|---|
| `bnf_profiles` | 사용자 프로필 (role, approved, settings jsonb=telegram/ollama) |
| `bnf_strategies` | 전략 목록 + 전역 enabled 토글 (시드 7종) |
| `bnf_user_strategy_access` | 사용자별 전략 허용/차단 (전역보다 우선) |
| `bnf_watchlist` | 관심종목 |
| `bnf_backtests` | 백테스트 결과 저장 |
| `bnf_paper_accounts` / `bnf_paper_positions` | 모의투자 계좌·포지션 |
| `bnf_user_positions` | 수동 등록 포지션 (`/positions`) |
| `bnf_admin_config` | 전역 리포트 설정 (단일 행 id=1, config jsonb) |
| `bnf_trading_settings` | ★ 자동매매 **브로커 연결 정보만**(broker, mode, 암호화된 키, 계좌번호, 토큰 캐시). `strategy_code`/`budget_pct`/`universe`/`interval_min`/`max_positions`/`enabled`/`status` 컬럼은 레거시(더 이상 사용 안 함) |
| `bnf_trading_strategies` | ★ 전략 카드 — id별로 완전 독립(strategy_code, universe, interval_min, max_positions, budget=원화 절대금액, status, last_run_at, last_error). 카드 여러 개 동시 실행 가능, (user_id,strategy_code) 유니크 제약 없음 |
| `bnf_live_positions` | ★ 자동매매 전략 포지션 상태 (sl/tp1 추적, strategy_code로 각자 전략 귀속) |
| `bnf_live_trades` | ★ 자동매매 거래이력 (삭제 안 함, CSV 다운로드) |
| `bnf_trade_logs` | ★ 자동매매 로그 (트리거/주문/응답/오류) |

> 스키마 변경 시: `schema.sql`은 **멱등(idempotent)** 하게 작성(`create table if not exists`, `drop policy if exists`, `on conflict do nothing`). 사용자가 Supabase SQL Editor에서 재실행하면 반영됨.

---

## 9. 배포

**GitHub 연동 자동배포** (권장, 현재 방식): `git push origin main` → Netlify가 자동 빌드·배포.
- Build: `npm run build` / Publish: `dist` / Functions: `netlify/functions` (netlify.toml에 설정됨)
- 예약함수(notify/report/trader)는 `export const config = { schedule }` 로 자동 등록됨.
- **주의**: Netlify Drop(드래그 배포)은 함수를 배포하지 않음 → 반드시 GitHub 연동.

**신규 기능 배포 시 사용자 안내(순서)**:
1. Supabase SQL Editor에서 `supabase/schema.sql` 재실행 (새 테이블/전략)
2. Netlify 환경변수 추가 (해당 기능이 요구하는 서버 키) → 재배포
3. 자동매매는 KIS 키를 [KIS Developers](https://apiportal.koreainvestment.com)에서 발급 (모의투자 키 우선)

---

## 10. 코딩 컨벤션

- 주석·UI 문자열은 **한국어**. 코드 스타일은 주변 코드에 맞춤(간결, 함수형).
- 서버 함수(`.mts`)는 ESM. `src/lib` 공용 모듈을 상대경로 import (번들은 esbuild가 처리).
- `src/lib/broker/`, `report-core.ts`는 **서버 전용** — 클라이언트에서 import 금지(node:crypto 등).
- 파일 새로 만들 때 임시 파일은 스크래치패드 디렉토리 사용, 프로젝트에 남기지 않기.
- 에러는 사용자에게 정직하게 보고(빌드 실패 시 그대로 전달).

---

## 11. 현재 상태 & 다음 작업 후보

### 완료 (HEAD `6247341`까지)
- 전략 7종 엔진, 스캐너/차트/백테스트/모의투자
- 텔레그램 알림(notify) + 이메일 리포트(report/run-report, 관리자 수동발송 버튼)
- 대시보드 커스터마이즈(개별종목 카드 최대5개), 사이드바 토글, 브라우저 전체화면
- 자동매매 전체(Broker Adapter, trader 엔진, broker API, TradingPage, DB 4테이블)

### 다음 작업 후보 (미착수 — 사용자 요청 시)
- **토스증권 어댑터 실구현** (공개 API 공개 시)
- 자동매매 **지정가/미체결/주문취소** UI (현재 시장가 위주, cancelOrder는 어댑터엔 있음)
- 자동매매 **일부 강제매도 UI 개선**, 주문내역 탭(체결/미체결/취소 분리)
- 백테스트에 전략7(disparity) 파라미터 튜닝 UI
- 리포트/알림 **주간 요약**, 성과 추적 대시보드
- 모바일 반응형 점검

### 알려진 제약/주의
- Yahoo 시세는 전체 종목 열거 불가 → `marketData.ts`의 curated 대형주 목록으로 유니버스 구성.
- 실시세 조회(`query1.finance.yahoo.com`) 실패 시 `query2.finance.yahoo.com`으로 1회 자동 재시도(`yahoo.mts`, `trader.mts`) 후에도 실패하면 합성(데모) 데이터로 폴백함. 폴백 발생 시 원인은 브라우저 콘솔(`[marketData] ... 실시세 조회 실패`)과 Netlify 함수 로그(`[yahoo proxy] ...`)에서 확인 가능 — 대개 Yahoo 측 일시 레이트리밋/차단이 원인이며 완전 근절은 불가.
- 게스트 데모 모드의 합성 데이터는 봉주기별로 값이 달라 카드 vs 신호표 가격이 다르게 보일 수 있음(실배포 실데이터에선 일치).
- 토스증권 자동매매 불가(공개 API 미제공) — KIS만 실동작.
- 자동매매 실전 모드는 실제 자금 손실 위험. 모의투자 모드 우선 검증 필수.

---

## 12. 참고 (Claude 메모리)

이 프로젝트의 Claude 자동 메모리(세션 간 유지)에 3개 항목이 있음(`~/.claude/projects/.../memory/`): `bnf-deployment`(배포/텔레그램), `bnf-strategies`(전략 엔진), `bnf-autotrading`(자동매매). 새 세션에서도 시스템이 자동 로드하므로 참고 가능.

---

*이 문서는 개발이 진행되면 함께 갱신하세요. 특히 새 전략/테이블/함수/환경변수 추가 시 해당 섹션을 업데이트할 것.*
