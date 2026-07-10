// ===== 한국 증시 개장 시간 판별 (KST 기준) =====
// 정규장: 평일(월~금) 09:00 ~ 15:30. (공휴일은 반영하지 않음)

export interface KstParts {
  year: number; month: number; day: number;
  hour: number; minute: number;
  weekday: number; // 0=일 ~ 6=토
  dateStr: string; // YYYY-MM-DD
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function kstNow(d: Date = new Date()): KstParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    year: +get('year'), month: +get('month'), day: +get('day'),
    hour, minute: +get('minute'),
    weekday: WD[get('weekday')] ?? 0,
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** 현재(또는 지정 시각) 한국 정규장 개장 여부 */
export function isKoreanMarketOpen(d: Date = new Date()): boolean {
  const k = kstNow(d);
  if (k.weekday === 0 || k.weekday === 6) return false;
  const mins = k.hour * 60 + k.minute;
  return mins >= 9 * 60 && mins <= 15 * 60 + 30;
}
