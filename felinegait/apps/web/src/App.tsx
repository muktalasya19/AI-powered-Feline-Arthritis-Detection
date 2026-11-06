import { Link, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import SignIn from "./pages/SignIn";
import Cats from "./pages/Cats";
import CatDetail from "./pages/CatDetail";
import NewTest from "./pages/NewTest";

export default function App() {
  const { user, loading, signOut } = useAuth();

  if (loading) return <div className="p-8 text-stone-500">Loading…</div>;
  if (!user) return <SignIn />;

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16">
      <header className="flex items-center justify-between py-5">
        <Link to="/" className="text-lg font-semibold">
          PurrStride
        </Link>
        <div className="flex items-center gap-3 text-sm text-stone-600">
          <span className="hidden sm:inline">{user.email}</span>
          <button className="btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Cats />} />
        <Route path="/cats/:catId" element={<CatDetail />} />
        <Route path="/cats/:catId/test" element={<NewTest />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <footer className="mt-16 text-xs text-stone-400">
        PurrStride is a screening aid, not a diagnosis. Always consult your vet.
      </footer>
    </div>
  );
}
