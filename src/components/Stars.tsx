export default function Stars({ n }: { n: number }) {
  return (
    <span className="text-amber-400 tracking-tight">
      {'★'.repeat(n)}
      <span className="text-slate-600">{'★'.repeat(Math.max(0, 5 - n))}</span>
    </span>
  );
}
