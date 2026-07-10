// ===== 리포트 수동 발송 (관리자 전용 HTTP 함수) =====
// 관리자 페이지의 "지금 보내기" 버튼이 호출한다.
// 요청: POST /api/run-report  { type: 'daily' | 'full', accessToken }
// - accessToken(로그인 사용자 JWT)을 검증해 관리자만 실행 허용
// - 예약 스케줄/발송이력과 무관하게 즉시 발송 (lastSentDate 갱신하지 않음)
import { createClient } from '@supabase/supabase-js';
import { buildDailyReport, buildFullReport, sendEmail, ReportCfg } from '../../src/lib/report-core';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'BNF Studio <onboarding@resend.dev>';
  if (!url || !key) return json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY 등 서버 환경변수가 설정되지 않았습니다.' }, 500);
  if (!resendKey) return json({ ok: false, error: 'RESEND_API_KEY가 설정되지 않았습니다.' }, 500);

  let type = '', accessToken = '';
  try {
    const b = await req.json();
    type = b.type; accessToken = b.accessToken;
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  if (type !== 'daily' && type !== 'full') return json({ ok: false, error: 'type must be daily|full' }, 400);
  if (!accessToken) return json({ ok: false, error: '로그인이 필요합니다.' }, 401);

  const sb = createClient(url, key, { auth: { persistSession: false } });

  // 관리자 검증
  const { data: userData, error: userErr } = await sb.auth.getUser(accessToken);
  if (userErr || !userData?.user) return json({ ok: false, error: '인증 실패 (토큰 무효)' }, 401);
  const { data: prof } = await sb.from('bnf_profiles').select('role, approved').eq('id', userData.user.id).single();
  if (prof?.role !== 'admin' || !prof?.approved) return json({ ok: false, error: '관리자 권한이 필요합니다.' }, 403);

  const { data: row } = await sb.from('bnf_admin_config').select('config').eq('id', 1).maybeSingle();
  const cfg = (row?.config ?? {}) as ReportCfg;

  const recipient = type === 'daily' ? cfg.reportRecipient : cfg.fullReportRecipient;
  if (!recipient) return json({ ok: false, error: `${type === 'daily' ? '일일' : '전체'} 리포트 수신 이메일이 설정되지 않았습니다.` }, 400);

  try {
    const { subject, html } = type === 'daily' ? await buildDailyReport(cfg) : await buildFullReport();
    const { ok, error } = await sendEmail(resendKey, from, recipient, subject, html);
    if (!ok) return json({ ok: false, error: error ?? '이메일 발송 실패' }, 502);
    return json({ ok: true, recipient });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
};
