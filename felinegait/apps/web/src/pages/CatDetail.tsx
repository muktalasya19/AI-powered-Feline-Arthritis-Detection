import { Link, useParams } from "react-router-dom";
import { collection, doc, orderBy, query } from "firebase/firestore";
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { db } from "../lib/firebase";
import { useCollection, useDoc } from "../hooks/useFirestore";
import RiskBadge from "../components/RiskBadge";
import { STATUS_LABEL, type Cat, type Session } from "../lib/types";
import { api } from "../lib/api";
import { useState } from "react";

export default function CatDetail() {
  const { catId = "" } = useParams();
  const { data: cat } = useDoc<Cat>(doc(db, "cats", catId));
  const { data: sessions } = useCollection<Session>(
    () => query(collection(db, "cats", catId, "sessions"), orderBy("createdAt", "asc")),
    `sessions:${catId}`,
  );
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const done = sessions.filter((s) => s.status === "done" && typeof s.score === "number");
  const trend = done.map((s) => ({
    date: s.createdAt?.toDate().toLocaleDateString(undefined, { month: "short", day: "numeric" }) ?? "",
    score: s.score,
  }));
  const latest = done.at(-1);

  async function share() {
    const { url } = await api<{ url: string }>("/share", { catId });
    setShareUrl(url);
  }

  if (!cat) return <p className="text-stone-500">Loading…</p>;

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/" className="text-sm text-stone-500">
            ← All cats
          </Link>
          <h1 className="text-2xl font-semibold">{cat.name}</h1>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={share}>
            Share with vet
          </button>
          <Link to={`/cats/${catId}/test`} className="btn-primary">
            New test
          </Link>
        </div>
      </div>

      {shareUrl && (
        <div className="card text-sm">
          Send this link to your clinic (valid 14 days): <code className="break-all">{shareUrl}</code>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="text-sm text-stone-500">Latest score</p>
          <p className="text-4xl font-semibold tabular-nums">{latest?.score ?? "–"}</p>
          <div className="mt-2">
            <RiskBadge level={latest?.riskLevel} />
          </div>
        </div>
        <div className="card sm:col-span-2">
          <p className="text-sm text-stone-500">Gait breakdown</p>
          {latest?.features ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <Feature label="Stride symmetry" value={`${Math.round(latest.features.strideSymmetry * 100)}%`} />
              <Feature label="Cadence" value={`${latest.features.cadence.toFixed(1)} steps/s`} />
              <Feature label="Smoothness" value={latest.features.smoothness.toFixed(2)} />
              <Feature label="Spine curvature" value={`${latest.features.spineCurvature.toFixed(1)}°`} />
            </dl>
          ) : (
            <p className="mt-2 text-sm text-stone-400">Run a test to see the breakdown.</p>
          )}
        </div>
      </div>

      <div className="card">
        <p className="mb-3 text-sm text-stone-500">Mobility score over time</p>
        {trend.length < 2 ? (
          <p className="text-sm text-stone-400">The trend appears after two completed tests.</p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <ReferenceArea y1={0} y2={40} fill="#fee2e2" fillOpacity={0.5} />
              <ReferenceArea y1={40} y2={70} fill="#fef3c7" fillOpacity={0.5} />
              <CartesianGrid stroke="#e7e5e4" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line type="monotone" dataKey="score" stroke="#1c1917" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="card">
        <p className="mb-3 text-sm text-stone-500">Test history</p>
        <ul className="divide-y divide-stone-100 text-sm">
          {[...sessions].reverse().map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <span>{s.createdAt?.toDate().toLocaleString() ?? "Just now"}</span>
              <span className="text-stone-500">
                {s.status === "done" ? `Score ${s.score}` : STATUS_LABEL[s.status]}
                {s.status === "rejected" && s.rejectReason ? ` — ${s.rejectReason}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Feature({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </>
  );
}
