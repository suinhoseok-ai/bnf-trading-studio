import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../lib/supabase';
import type { Profile, Strategy } from '../lib/types';
import { ALL_STRATEGIES } from '../lib/strategies';

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  strategies: Strategy[];
  /** 이 사용자가 사용할 수 있는 전략 코드 목록 (전역 enabled + 사용자별 권한 반영) */
  allowedStrategyCodes: string[];
  loading: boolean;
  guestMode: boolean; // Supabase 미설정 시 데모 게스트 모드
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>(null as unknown as AuthState);

const GUEST_PROFILE: Profile = {
  id: 'guest',
  email: 'guest@demo',
  name: '게스트 (데모)',
  role: 'admin',
  approved: true,
  settings: {},
  created_at: new Date().toISOString(),
};

const GUEST_STRATEGIES: Strategy[] = ALL_STRATEGIES.map((m, i) => ({
  id: i + 1,
  code: m.code,
  name: m.name,
  description: m.short,
  enabled: true,
  params: m.params,
}));
const GUEST_CODES = ALL_STRATEGIES.map((m) => m.code);

export function AuthProvider({ children }: { children: ReactNode }) {
  const guestMode = !supabaseConfigured;
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(guestMode ? GUEST_PROFILE : null);
  const [strategies, setStrategies] = useState<Strategy[]>(guestMode ? GUEST_STRATEGIES : []);
  const [allowed, setAllowed] = useState<string[]>(guestMode ? GUEST_CODES : []);
  const [loading, setLoading] = useState(!guestMode);

  const loadProfile = useCallback(async (userId: string) => {
    const { data: prof } = await supabase.from('bnf_profiles').select('*').eq('id', userId).single();
    setProfile((prof as unknown as Profile) ?? null);

    const { data: strats } = await supabase.from('bnf_strategies').select('*').order('id');
    const stratList = (strats as unknown as Strategy[]) ?? [];
    setStrategies(stratList);

    const { data: access } = await supabase
      .from('bnf_user_strategy_access')
      .select('strategy_id, enabled')
      .eq('user_id', userId);
    const overrides = new Map((access ?? []).map((a: { strategy_id: number; enabled: boolean }) => [a.strategy_id, a.enabled]));
    setAllowed(
      stratList
        .filter((s) => (overrides.has(s.id) ? overrides.get(s.id) : s.enabled))
        .map((s) => s.code),
    );
  }, []);

  useEffect(() => {
    if (guestMode) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) loadProfile(data.session.user.id).finally(() => setLoading(false));
      else setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s) loadProfile(s.user.id);
      else {
        setProfile(null);
        setAllowed([]);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [guestMode, loadProfile]);

  const refreshProfile = useCallback(async () => {
    if (guestMode) return;
    if (session) await loadProfile(session.user.id);
  }, [guestMode, session, loadProfile]);

  const signOut = useCallback(async () => {
    if (guestMode) return;
    await supabase.auth.signOut();
  }, [guestMode]);

  return (
    <AuthContext.Provider
      value={{ session, profile, strategies, allowedStrategyCodes: allowed, loading, guestMode, refreshProfile, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
