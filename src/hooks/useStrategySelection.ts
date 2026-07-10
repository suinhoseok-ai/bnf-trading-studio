import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

/** 선택 전략 코드 상태 — 권한 없는 전략이면 자동으로 허용된 첫 전략으로 보정 */
export function useStrategySelection(initial = 'bnf1'): [string, (c: string) => void] {
  const { allowedStrategyCodes } = useAuth();
  const [code, setCode] = useState<string>(initial);
  useEffect(() => {
    if (allowedStrategyCodes.length && !allowedStrategyCodes.includes(code)) {
      setCode(allowedStrategyCodes[0]);
    }
  }, [allowedStrategyCodes, code]);
  return [code, setCode];
}
