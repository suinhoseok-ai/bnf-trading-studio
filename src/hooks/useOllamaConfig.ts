import { useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { DEFAULT_OLLAMA, OllamaConfig } from '../lib/ollama';

/** 사용자별 Ollama 설정 (profiles.settings 저장, 게스트는 localStorage) */
export function useOllamaConfig(): [OllamaConfig, (c: OllamaConfig) => Promise<void>] {
  const { profile, guestMode, refreshProfile } = useAuth();

  const local = (() => {
    try {
      return JSON.parse(localStorage.getItem('ollamaConfig') ?? 'null');
    } catch {
      return null;
    }
  })();

  const config: OllamaConfig = {
    url: profile?.settings?.ollamaUrl ?? local?.url ?? DEFAULT_OLLAMA.url,
    model: profile?.settings?.ollamaModel ?? local?.model ?? DEFAULT_OLLAMA.model,
  };

  const save = useCallback(
    async (c: OllamaConfig) => {
      localStorage.setItem('ollamaConfig', JSON.stringify(c));
      if (!guestMode && profile) {
        await supabase
          .from('bnf_profiles')
          .update({ settings: { ...profile.settings, ollamaUrl: c.url, ollamaModel: c.model } })
          .eq('id', profile.id);
        await refreshProfile();
      }
    },
    [guestMode, profile, refreshProfile],
  );

  return [config, save];
}
