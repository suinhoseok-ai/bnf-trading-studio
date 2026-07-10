// ===== 일일 이메일 스캔 리포트 (Netlify 예약 함수) =====
// 관리자 페이지에서 설정한 요일/시각(KST)에 맞춰 전체(또는 시장별) 종목을 스캔하고
// 종목 스캐너 결과를 정렬해 상위 N개를 이메일로 발송한다.
//
// 필요한 Netlify 환경변수:
//   SUPABASE_URL (또는 VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY  (https://resend.com — 이메일 발송)
//   RESEND_FROM     (선택, 기본 'BNF Studio <onboarding@resend.dev>')
import { createClient } from '@supabase/supabase-js';
import type { Candle } from '../../src/lib/types';
import { getStrategy, ALL_STRATEGIES } from '../../src/lib/strategies';
import type { StratScan, StrategyModule } from '../../src/lib/strategies/types';
import { KOSPI_TOP, KOSDAQ_TOP, ALL_STOCKS, KOSPI_STOCKS, KOSDAQ_STOCKS } from '../../src/lib/marketData';
import { kstNow } from '../../src/lib/market-hours';

export const config = { schedule: '0 * * * *' };

const BATCH = 6;

async function fetchCandlesServer(symbol: string, interval: string, range: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BNFStudio/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no data');
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return candles;
}

async function inBatches<T>(arr: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < arr.length; i += size) await Promise.all(arr.slice(i, i + size).map(fn));
}

function buildHtml(stratName: string, headers: string[], rows: StratScan[]): string {
  const th = (t: string) => `<th style="padding:6px 10px;border-bottom:2px solid #334155;text-align:left;font-size:12px;color:#94a3b8">${t}</th>`;
  const td = (t: string, extra = '') => `<td style="padding:6px 10px;border-bottom:1px solid #1f2b47;font-size:13px;${extra}">${t}</td>`;
  const head = ['종목', '현재가', '등락', ...headers, '매수', '매도', '점수', '추천도'].map(th).join('');
  const body = rows.map((r) => {
    const cols = r.cols.map((c) => td(c.value)).join('');
    return `<tr>${td(`<b>${r.name}</b>`)}${td(Math.round(r.price).toLocaleString('ko-KR'))}${td(`${r.changePct.toFixed(2)}%`, r.changePct >= 0 ? 'color:#ef4444' : 'color:#3b82f6')}${cols}${td(r.buy ? '🟢 매수' : '-')}${td(r.exit ? '🔴 매도' : '-')}${td(`<b>${r.score}</b>`)}${td('★'.repeat(r.stars) + '☆'.repeat(5 - r.stars))}</tr>`;
  }).join('');
  return `<div style="font-family:sans-serif;background:#0b1220;color:#e2e8f0;padding:20px">
    <h2 style="color:#fff">📊 BNF Trading Studio · 일일 스캔 리포트</h2>
    <p style="color:#94a3b8">전략: ${stratName} · 생성: ${new Date().toLocaleString('ko-KR')}</p>
    <table style="border-collapse:collapse;width:100%"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <p style="color:#64748b;font-size:12px;margin-top:16px">본 메일은 학습·연구용 시뮬레이터의 자동 발송이며 투자 권유가 아닙니다.</p>
  </div>`;
}

async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string): Promise<boolean> {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!r.ok) console.log('[report] Resend 오류:', r.status, await r.text().catch(() => ''));
    return r.ok;
  } catch (e) {
    console.log('[report] 이메일 발송 실패:', String(e));
    return false;
  }
}

interface ReportCfg {
  reportEnabled?: boolean; reportDays?: number[]; reportHour?: number;
  reportStrategy?: string; reportMarket?: 'KOSPI' | 'KOSDAQ' | 'ALL';
  reportMaxStocks?: number; reportSortBy?: 'score' | 'changePct';
  reportTopN?: number; reportRecipient?: string; reportLastSentDate?: string;
  fullReportEnabled?: boolean; fullReportDays?: number[]; fullReportHour?: number;
  fullReportRecipient?: string; fullReportLastSentDate?: string;
}

/** 전체 리포트: 전 전략 × 코스피15+코스닥8 (섹션별 HTML) */
async function buildFullReportHtml(): Promise<string> {
  const stocks = [...KOSPI_STOCKS, ...KOSDAQ_STOCKS];
  // 시세 요약 (1d 캔들 재사용을 위해 심볼별 캐시)
  const candleCache = new Map<string, Candle[]>();
  const getCandles = async (symbol: string, interval: string, range: string) => {
    const key = `${symbol}|${interval}|${range}`;
    const hit = candleCache.get(key);
    if (hit) return hit;
    const c = await fetchCandlesServer(symbol, interval, range);
    candleCache.set(key, c);
    return c;
  };

  const quotes = new Map<string, { prevClose: number; high: number; low: number; volume: number; tradeValue: number }>();
  await inBatches(stocks, BATCH, async (s) => {
    try {
      const c = await getCandles(s.symbol, '1d', '5d');
      const last = c[c.length - 1], prev = c[c.length - 2];
      if (last) quotes.set(s.symbol, { prevClose: prev?.close ?? last.close, high: last.high, low: last.low, volume: last.volume, tradeValue: last.close * last.volume });
    } catch { /* skip */ }
  });

  const fmtN = (n: number) => Math.round(n).toLocaleString('ko-KR');
  const fmtEok = (n: number) => `${Math.round(n / 1_0000_0000).toLocaleString('ko-KR')}억`;
  const th = (t: string) => `<th style="padding:5px 8px;border-bottom:2px solid #334155;text-align:left;font-size:11px;color:#94a3b8;white-space:nowrap">${t}</th>`;
  const td = (t: string, extra = '') => `<td style="padding:5px 8px;border-bottom:1px solid #1f2b47;font-size:12px;white-space:nowrap;${extra}">${t}</td>`;

  const sections: string[] = [];
  for (const mod of ALL_STRATEGIES as StrategyModule[]) {
    await mod.init?.(fetchCandlesServer);
    const scans: StratScan[] = [];
    await inBatches(stocks, BATCH, async (s) => {
      try {
        const candles = await getCandles(s.symbol, mod.interval, mod.range);
        if (candles.length < 30) return;
        scans.push(mod.scan(s.symbol, s.name, mod.compute(candles)));
      } catch { /* skip */ }
    });
    scans.sort((a, b) => b.score - a.score);

    const head = ['종목', '현재가', '등락', '전일', '고가', '저가', '거래량', '대금', ...mod.colHeaders, '매수', '매도', '점수', '추천도'].map(th).join('');
    const body = scans.map((r) => {
      const q = quotes.get(r.symbol);
      const cols = r.cols.map((c) => td(c.value)).join('');
      return `<tr>${td(`<b>${r.name}</b>`)}${td(fmtN(r.price))}${td(`${r.changePct.toFixed(2)}%`, r.changePct >= 0 ? 'color:#ef4444' : 'color:#3b82f6')}` +
        `${td(q ? fmtN(q.prevClose) : '-')}${td(q ? fmtN(q.high) : '-')}${td(q ? fmtN(q.low) : '-')}${td(q ? fmtN(q.volume) : '-')}${td(q ? fmtEok(q.tradeValue) : '-')}` +
        `${cols}${td(r.buy ? '🟢 매수' : '-')}${td(r.exit ? '🔴 매도' : '-')}${td(`<b>${r.score}</b>`)}${td('★'.repeat(r.stars) + '☆'.repeat(5 - r.stars))}</tr>`;
    }).join('');
    sections.push(
      `<h3 style="color:#fff;margin:24px 0 4px">${mod.name}</h3>` +
      `<p style="color:#64748b;font-size:12px;margin:0 0 8px">${mod.short}</p>` +
      `<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    );
  }

  return `<div style="font-family:sans-serif;background:#0b1220;color:#e2e8f0;padding:20px">
    <h2 style="color:#fff">📑 BNF Trading Studio · 전체 전략 리포트</h2>
    <p style="color:#94a3b8">코스피 ${KOSPI_STOCKS.length} · 코스닥 ${KOSDAQ_STOCKS.length} 종목 × 전략 ${ALL_STRATEGIES.length}종 · 생성: ${new Date().toLocaleString('ko-KR')}</p>
    ${sections.join('')}
    <p style="color:#64748b;font-size:12px;margin-top:16px">본 메일은 학습·연구용 시뮬레이터의 자동 발송이며 투자 권유가 아닙니다.</p>
  </div>`;
}

export default async () => {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'BNF Studio <onboarding@resend.dev>';
  if (!url || !key) { console.log('[report] Supabase 환경변수 미설정'); return new Response('skip: env'); }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data: row } = await sb.from('bnf_admin_config').select('config').eq('id', 1).maybeSingle();
  let cfg = (row?.config ?? {}) as ReportCfg;
  const k = kstNow();
  const status: string[] = [];

  // ── 1. 일일 스캔 리포트 (단일 전략 · 상위 N) ──
  if (
    cfg.reportEnabled && resendKey && cfg.reportRecipient &&
    (cfg.reportDays ?? [1, 2, 3, 4, 5]).includes(k.weekday) &&
    k.hour === (cfg.reportHour ?? 17) &&
    cfg.reportLastSentDate !== k.dateStr
  ) {
    const mod = getStrategy(cfg.reportStrategy || 'bnf1');
    await mod.init?.(fetchCandlesServer);
    const market = cfg.reportMarket || 'ALL';
    const pool = market === 'KOSPI' ? KOSPI_TOP : market === 'KOSDAQ' ? KOSDAQ_TOP : ALL_STOCKS;
    const stocks = pool.slice(0, Math.max(1, cfg.reportMaxStocks ?? 60));

    const results: StratScan[] = [];
    await inBatches(stocks, BATCH, async (s) => {
      try {
        const candles = await fetchCandlesServer(s.symbol, mod.interval, mod.range);
        if (candles.length < 30) return;
        results.push(mod.scan(s.symbol, s.name, mod.compute(candles)));
      } catch { /* skip */ }
    });
    const sortBy = cfg.reportSortBy || 'score';
    results.sort((a, b) => (sortBy === 'changePct' ? b.changePct - a.changePct : b.score - a.score));
    const top = results.slice(0, Math.max(1, cfg.reportTopN ?? 20));

    const ok = await sendEmail(resendKey, from, cfg.reportRecipient,
      `[BNF] ${mod.name.split('·')[0].trim()} 스캔 리포트 (${k.dateStr})`,
      buildHtml(mod.name, mod.colHeaders, top));
    if (ok) {
      cfg = { ...cfg, reportLastSentDate: k.dateStr };
      await sb.from('bnf_admin_config').update({ config: cfg, updated_at: new Date().toISOString() }).eq('id', 1);
    }
    status.push(`daily:${ok ? 'sent' : 'fail'}(${top.length})`);
    console.log(`[report] 일일 리포트 ${ok ? '발송 완료' : '발송 실패'} · 상위 ${top.length}종목`);
  }

  // ── 2. 전체 리포트 (전 전략 × 주요 종목) ──
  if (
    cfg.fullReportEnabled && resendKey && cfg.fullReportRecipient &&
    (cfg.fullReportDays ?? [1, 2, 3, 4, 5]).includes(k.weekday) &&
    k.hour === (cfg.fullReportHour ?? 17) &&
    cfg.fullReportLastSentDate !== k.dateStr
  ) {
    const html = await buildFullReportHtml();
    const ok = await sendEmail(resendKey, from, cfg.fullReportRecipient,
      `[BNF] 전체 전략 리포트 (${k.dateStr})`, html);
    if (ok) {
      cfg = { ...cfg, fullReportLastSentDate: k.dateStr };
      await sb.from('bnf_admin_config').update({ config: cfg, updated_at: new Date().toISOString() }).eq('id', 1);
    }
    status.push(`full:${ok ? 'sent' : 'fail'}`);
    console.log(`[report] 전체 리포트 ${ok ? '발송 완료' : '발송 실패'}`);
  }

  return new Response(status.length ? status.join(' ') : 'skip: nothing due');
};
