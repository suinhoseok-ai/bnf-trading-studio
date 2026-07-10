import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Supabase 환경변수 설정 여부 (미설정 시 게스트 데모 모드로 동작) */
export const supabaseConfigured = Boolean(url && anonKey && !url.includes('YOUR_PROJECT'));

export const supabase = supabaseConfigured
  ? createClient(url!, anonKey!)
  : (null as unknown as ReturnType<typeof createClient>);
