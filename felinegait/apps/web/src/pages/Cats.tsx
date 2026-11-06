import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { addDoc, collection, query, serverTimestamp, where } from "firebase/firestore";
import { db } from "../lib/firebase";
import { useAuth } from "../hooks/useAuth";
import { useCollection } from "../hooks/useFirestore";
import RiskBadge from "../components/RiskBadge";
import type { Cat } from "../lib/types";

export default function Cats() {
  const { user } = useAuth();
  const uid = user!.uid;
  const { data: cats, loading } = useCollection<Cat>(
    () => query(collection(db, "cats"), where("ownerUid", "==", uid)),
    `cats:${uid}`,
  );
  const [name, setName] = useState("");
  const [birthYear, setBirthYear] = useState("");

  async function addCat(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await addDoc(collection(db, "cats"), {
      name: name.trim(),
      ownerUid: uid,
      birthYear: birthYear ? Number(birthYear) : null,
      createdAt: serverTimestamp(),
    });
    setName("");
    setBirthYear("");
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Your cats</h1>

      {loading ? (
        <p className="mt-6 text-stone-500">Loading…</p>
      ) : cats.length === 0 ? (
        <p className="mt-6 text-stone-500">Add your first cat to start a mobility test.</p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {cats.map((cat) => (
            <li key={cat.id}>
              <Link to={`/cats/${cat.id}`} className="card block hover:border-stone-400">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-lg font-semibold">{cat.name}</p>
                    {cat.birthYear && (
                      <p className="text-sm text-stone-500">{new Date().getFullYear() - cat.birthYear} years old</p>
                    )}
                  </div>
                  <p className="text-3xl font-semibold tabular-nums">{cat.latestScore ?? "–"}</p>
                </div>
                <div className="mt-3">
                  <RiskBadge level={cat.latestRiskLevel} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addCat} className="card mt-8 grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
        <label className="text-sm">
          Name
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Miso" />
        </label>
        <label className="text-sm">
          Birth year
          <input
            className="input mt-1"
            type="number"
            min={1990}
            max={new Date().getFullYear()}
            value={birthYear}
            onChange={(e) => setBirthYear(e.target.value)}
          />
        </label>
        <button className="btn-primary" type="submit">
          Add cat
        </button>
      </form>
    </section>
  );
}
