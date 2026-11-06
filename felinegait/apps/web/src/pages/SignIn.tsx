import { useAuth } from "../hooks/useAuth";

export default function SignIn() {
  const { signIn } = useAuth();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold">PurrStride</h1>
      <p className="mt-3 text-stone-600">
        Record a short video of your cat walking and get a mobility score, a gait breakdown and a trend over time.
      </p>
      <button className="btn-primary mt-8" onClick={signIn}>
        Continue with Google
      </button>
      <p className="mt-6 text-xs text-stone-400">A screening aid, not a diagnosis.</p>
    </main>
  );
}
