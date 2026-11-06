import { RISK_LABEL, type RiskLevel } from "../lib/types";

const STYLE: Record<RiskLevel, string> = {
  low: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  watch: "bg-amber-50 text-amber-700 ring-amber-200",
  see_vet: "bg-red-50 text-red-700 ring-red-200",
};

export default function RiskBadge({ level }: { level?: RiskLevel }) {
  if (!level) return <span className="text-xs text-stone-400">No result yet</span>;
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${STYLE[level]}`}>
      {RISK_LABEL[level]}
    </span>
  );
}
