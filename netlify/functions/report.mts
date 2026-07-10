// ===== 이메일 스캔 리포트 (Netlify 예약 함수) =====
// 관리자 페이지에서 설정한 요일/시각(KST)에 맞춰 리포트를 이메일로 발송한다.
//   - 일일 리포트: 단일 전략 · 시장별 상위 N
//   - 전체 리포트: 전 전략 × 코스피15+코스닥8
//
// 필요한 Netlify 환경변수:
//   SUPABASE_URL (또는 VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY (https://resend.com), RESEND_FROM (선택)
import { createClient } from '@supabase/supabase-js';
import { kstNow } from '../../src/lib/market-hours';
import { buildDailyReport, buildFullReport, sendEmail, ReportCfg } from '../../src/lib/report-core';

export const config = { schedule: '0 * * * *' };

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

  // ── 1. 일일 스캔 리포트 ──
  if (
    cfg.reportEnabled && resendKey && cfg.reportRecipient &&
    (cfg.reportDays ?? [1, 2, 3, 4, 5]).includes(k.weekday) &&
    k.hour === (cfg.reportHour ?? 17) &&
    cfg.reportLastSentDate !== k.dateStr
  ) {
    const { subject, html, count } = await buildDailyReport(cfg);
    const { ok } = await sendEmail(resendKey, from, cfg.reportRecipient, subject, html);
    if (ok) {
      cfg = { ...cfg, reportLastSentDate: k.dateStr };
      await sb.from('bnf_admin_config').update({ config: cfg, updated_at: new Date().toISOString() }).eq('id', 1);
    }
    status.push(`daily:${ok ? 'sent' : 'fail'}(${count})`);
    console.log(`[report] 일일 리포트 ${ok ? '발송 완료' : '발송 실패'} · 상위 ${count}종목`);
  }

  // ── 2. 전체 리포트 ──
  if (
    cfg.fullReportEnabled && resendKey && cfg.fullReportRecipient &&
    (cfg.fullReportDays ?? [1, 2, 3, 4, 5]).includes(k.weekday) &&
    k.hour === (cfg.fullReportHour ?? 17) &&
    cfg.fullReportLastSentDate !== k.dateStr
  ) {
    const { subject, html } = await buildFullReport();
    const { ok } = await sendEmail(resendKey, from, cfg.fullReportRecipient, subject, html);
    if (ok) {
      cfg = { ...cfg, fullReportLastSentDate: k.dateStr };
      await sb.from('bnf_admin_config').update({ config: cfg, updated_at: new Date().toISOString() }).eq('id', 1);
    }
    status.push(`full:${ok ? 'sent' : 'fail'}`);
    console.log(`[report] 전체 리포트 ${ok ? '발송 완료' : '발송 실패'}`);
  }

  return new Response(status.length ? status.join(' ') : 'skip: nothing due');
};
