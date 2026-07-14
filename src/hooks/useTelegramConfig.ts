import { useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { DEFAULT_TELEGRAM, TelegramConfig } from '../lib/telegram';

/** 사용자별 텔레그램 설정 (profiles.settings.telegram 저장, 게스트는 localStorage) */
export function useTelegramConfig(): [TelegramConfig, (c: TelegramConfig) => Promise<void>] {
  const { profile, guestMode, refreshProfile } = useAuth();

  const local = (() => {
    try {
      return JSON.parse(localStorage.getItem('telegramConfig') ?? 'null');
    } catch {
      return null;
    }
  })();

  const saved = profile?.settings?.telegram ?? local ?? {};
  const config: TelegramConfig = {
    ...DEFAULT_TELEGRAM, ...saved,
    regimeNotify: { ...DEFAULT_TELEGRAM.regimeNotify, ...(saved.regimeNotify ?? {}) },
  };

  const save = useCallback(
    async (c: TelegramConfig) => {
      localStorage.setItem('telegramConfig', JSON.stringify(c));
      if (!guestMode && profile) {
        // 서버 알림 함수의 lastNotifiedAt 값을 덮어쓰지 않도록 기존 telegram 설정과 병합
        const prevTg = profile.settings?.telegram ?? {};
        await supabase
          .from('bnf_profiles')
          .update({ settings: { ...profile.settings, telegram: { ...prevTg, ...c } } })
          .eq('id', profile.id);
        await refreshProfile();
      }
    },
    [guestMode, profile, refreshProfile],
  );

  return [config, save];
}
