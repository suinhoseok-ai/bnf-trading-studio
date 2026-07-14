import { useAuth } from '../context/AuthContext';
import { ALL_STRATEGIES } from '../lib/strategies';

/** 사용 권한이 있는 전략만, 관리자가 지정한 순서(sort_order)대로 노출하는 선택 드롭다운 */
export default function StrategyPicker({ value, onChange, className = 'input w-auto' }: {
  value: string;
  onChange: (code: string) => void;
  className?: string;
}) {
  const { allowedStrategyCodes, strategies } = useAuth();
  // strategies는 이미 sort_order로 정렬되어 로드됨 (AuthContext) — 그 순서를 그대로 따른다.
  const ordered = strategies.length > 0 ? strategies : ALL_STRATEGIES.map((m) => ({ code: m.code, name: m.name }));
  const list = ordered.filter((s) => allowedStrategyCodes.includes(s.code));
  if (list.length === 0) return null;
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((s) => (
        <option key={s.code} value={s.code}>{s.name}</option>
      ))}
    </select>
  );
}
