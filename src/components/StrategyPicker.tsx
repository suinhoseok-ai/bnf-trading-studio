import { useAuth } from '../context/AuthContext';
import { ALL_STRATEGIES } from '../lib/strategies';

/** 사용 권한이 있는 전략만 노출하는 선택 드롭다운 */
export default function StrategyPicker({ value, onChange, className = 'input w-auto' }: {
  value: string;
  onChange: (code: string) => void;
  className?: string;
}) {
  const { allowedStrategyCodes } = useAuth();
  const list = ALL_STRATEGIES.filter((m) => allowedStrategyCodes.includes(m.code));
  if (list.length === 0) return null;
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {list.map((m) => (
        <option key={m.code} value={m.code}>{m.name}</option>
      ))}
    </select>
  );
}
