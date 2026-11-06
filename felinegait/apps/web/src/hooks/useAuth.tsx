import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db, googleProvider } from "../lib/firebase";

/** Create users/{uid} on first sign-in (replaces the Cloud Functions auth trigger). */
async function ensureProfile(user: User) {
  const ref = doc(db, "users", user.uid);
  if ((await getDoc(ref)).exists()) return;
  await setDoc(ref, {
    name: user.displayName ?? "",
    email: user.email ?? "",
    plan: "free",
    orgIds: [],
    consentResearch: false,
    notificationPrefs: { push: true, email: true },
    createdAt: serverTimestamp(),
  });
}

interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(
    () =>
      onAuthStateChanged(auth, async (u) => {
        if (u) await ensureProfile(u).catch((e) => console.error("profile setup failed", e));
        setUser(u);
        setLoading(false);
      }),
    [],
  );

  const value: AuthState = {
    user,
    loading,
    signIn: async () => {
      await signInWithPopup(auth, googleProvider);
    },
    signOut: () => signOut(auth),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
