# BNF Trading Studio (AI Edition)

BNF 전략1 **(볼린저 밴드 수렴 회귀)** 기반의 웹 트레이딩 시뮬레이션 시스템입니다.

> 15분봉 기준 볼린저밴드(20, 2σ) 밴드폭이 수렴(Squeeze)한 상태에서 종가가 하단밴드를 하향 이탈하면 가용 현금의 10%로 매수 → 중심선 도달 시 50% 익절 + 손절가 본절 이동 → 상단밴드 도달 시 전량 익절. 초기 손절은 1:2 손익비.

## 주요 기능

| 메뉴 | 설명 |
|---|---|
| 대시보드 | KOSPI/KOSDAQ 지수, 오늘 신호 상위 종목, 모의투자 계좌 요약, 전략 규칙 요약 |
| 종목 스캐너 | KOSPI/KOSDAQ/관심종목 대상 BNF1 조건 충족도 점수(0~100) + 추천도(★1~5), 종목별 AI 분석 |
| 차트 분석 | TradingView Lightweight Charts — 캔들 + MA20 + 상/하단 밴드 + 매수/익절/손절 마커 |
| 백테스트 | 기간·봉주기·초기자본 설정 → 총수익률, 승률, MDD, Profit Factor, Sharpe, CAGR, 거래횟수, 평균보유기간 + 자산곡선 + 거래로그, 결과 DB 저장 |
| 모의투자 | 가상계좌(1,000만원) 자동매매 시뮬레이션 — 신호 매수, 분할 익절, 본절 이동, 손절, 수동청산, 거래내역 |
| AI 분석 (Qwen3) | 로컬 Ollama의 Qwen3와 대화 — 계산은 전략 엔진이, 분석/설명/추천/요약은 AI가 담당 |
| 설정 | 사용자별 Ollama URL/모델 설정 + 연결 테스트 |
| 관리자 | 회원가입 승인/취소, 역할 변경, 전략별 전역 사용유무 토글, 사용자별 전략 권한 관리 |

## 기술 스택

- **Frontend**: React 18 + Vite + TypeScript + Tailwind CSS
- **차트**: TradingView Lightweight Charts
- **DB / 인증**: Supabase (PostgreSQL + Auth + RLS)
- **로컬 AI**: Qwen3 via Ollama (`http://localhost:11434`)
- **시세**: Yahoo Finance (개발: Vite 프록시 / 배포: Netlify Function 프록시, 실패 시 합성 데모 데이터 폴백)
- **배포**: Netlify (+ Cloudflare DNS/CDN)

---

## 1. 로컬 실행

```bash
npm install
cp .env.example .env   # Supabase 키 입력 (미입력 시 게스트 데모 모드로 동작)
npm run dev            # http://localhost:5173
```

`.env` 없이 실행하면 **게스트 데모 모드**로 동작합니다 (로그인 없이 모든 기능 체험, 데이터는 브라우저 localStorage 저장).

## 2. Supabase 설정 (로그인/회원승인/사용자별 데이터)

1. https://supabase.com 에서 새 프로젝트 생성
2. **SQL Editor**에서 [`supabase/schema.sql`](supabase/schema.sql) 전체를 붙여넣고 실행
3. **Project Settings > API**에서 URL과 anon key를 복사해 `.env`에 입력:
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```
4. (선택) **Authentication > Providers > Email**에서 "Confirm email" 해제 시 이메일 인증 없이 가입 가능

**회원 흐름**: 회원가입 → `approved=false`로 생성 → 관리자가 [관리자 > 회원 관리]에서 승인 → 이용 가능.
**최초 가입자는 자동으로 관리자(admin) + 승인 상태**가 됩니다.

**권한 구조**:
- `strategies.enabled` — 전략별 전역 사용유무 (관리자 토글)
- `user_strategy_access` — 사용자별 개별 허용/차단 (전역 설정보다 우선)
- 모든 사용자 데이터(관심종목, 모의투자, 백테스트 결과, 설정)는 RLS로 본인+관리자만 접근 가능

## 3. Qwen3 (로컬 AI) 설정

```bash
# 1. Ollama 설치 (https://ollama.com)
# 2. Qwen3 모델 다운로드
ollama pull qwen3:8b

# 3. 브라우저에서 접근 가능하도록 CORS 허용 후 실행
# Windows (PowerShell):
$env:OLLAMA_ORIGINS="*"; ollama serve
# Windows (CMD):
set OLLAMA_ORIGINS=* && ollama serve
# Mac/Linux:
OLLAMA_ORIGINS=* ollama serve
```

앱의 [설정] 페이지에서 URL(`http://localhost:11434`)과 모델명을 입력하고 **연결 테스트**를 실행하세요.
설정은 사용자별로 계정에 저장됩니다. Ollama 미연결 시에도 규칙 기반 요약으로 폴백하여 동작합니다.

> 배포된 사이트(HTTPS)에서도 AI 기능은 **각 사용자 PC의 로컬 Ollama**를 호출합니다.
> 브라우저가 https 페이지에서 http://localhost 호출을 차단하는 경우(Firefox 등),
> Chrome/Edge 사용을 권장하며 그래도 차단되면 로컬 개발 모드로 사용하세요.

## 4. Netlify 배포

```bash
# GitHub 저장소 연결 방식 (권장)
git init && git add -A && git commit -m "init"
# GitHub에 push 후 Netlify에서 Import

# 또는 CLI 배포
npm i -g netlify-cli
netlify deploy --prod
```

- Build command: `npm run build` / Publish directory: `dist` (netlify.toml에 이미 설정됨)
- **Site settings > Environment variables**에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` 등록
- `netlify/functions/yahoo.mts`가 시세 프록시로 자동 배포됨

## 5. Cloudflare 호스팅(DNS/CDN) 연결

1. Cloudflare에 도메인 등록 (DNS 관리 이전)
2. Netlify **Domain settings**에서 커스텀 도메인 추가
3. Cloudflare DNS에 `CNAME` 레코드 추가: `www` → `<사이트명>.netlify.app` (Proxy 상태: Proxied 🟠)
4. Cloudflare **SSL/TLS 모드를 "Full (strict)"** 로 설정 (Flexible 사용 시 리다이렉트 루프 발생)

## 프로젝트 구조

```
├─ supabase/schema.sql          # DB 스키마 + RLS + 회원승인 트리거
├─ netlify/functions/yahoo.mts  # Yahoo Finance 프록시 (프로덕션)
├─ netlify.toml
└─ src/
   ├─ lib/
   │  ├─ indicators.ts   # 볼린저밴드·밴드폭·수렴(Squeeze)·매수신호 (명세서 3.1~3.3)
   │  ├─ simulator.ts    # 백테스트 엔진 — 분할익절/본절이동/1:2손익비 (명세서 3.4, 4~5장)
   │  ├─ scanner.ts      # 조건 충족도 점수(0~100) + 별점
   │  ├─ paper.ts        # 모의투자 포지션 처리 엔진
   │  ├─ marketData.ts   # 시세 수집 (Yahoo + 합성 데이터 폴백)
   │  ├─ ollama.ts       # Qwen3 연동 (분석/설명/추천/요약 전담)
   │  └─ supabase.ts
   ├─ context/AuthContext.tsx   # 세션·프로필·전략권한
   ├─ components/               # Layout, CandleChart, EquityChart, Stars
   └─ pages/                    # Login, Pending, Dashboard, Scanner, Chart,
                                #  Backtest, Paper, AI, Admin, Settings
```

## 면책 고지

본 시스템은 학습·연구용 시뮬레이터입니다. 백테스트/모의투자 결과는 미래 수익을 보장하지 않으며, 실제 투자 판단과 그 결과에 대한 책임은 전적으로 사용자 본인에게 있습니다.
