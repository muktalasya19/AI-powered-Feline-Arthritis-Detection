import { useEffect, useState } from "react";
import { onSnapshot, type DocumentReference, type Query } from "firebase/firestore";

/**
 * Live collection listener → array of docs with ids.
 * `key` must change whenever the query changes (e.g. the collection path + filters).
 */
export function useCollection<T>(
  makeQuery: () => Query | null,
  key: string,
): { data: T[]; loading: boolean; error?: Error } {
  const [state, setState] = useState<{ data: T[]; loading: boolean; error?: Error }>({ data: [], loading: true });
  useEffect(() => {
    const q = makeQuery();
    if (!q) return;
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T), loading: false }),
      (error) => setState({ data: [], loading: false, error }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Live document listener. */
export function useDoc<T>(ref: DocumentReference | null): { data: T | null; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; loading: boolean }>({ data: null, loading: true });
  useEffect(() => {
    if (!ref) return;
    return onSnapshot(ref, (snap) =>
      setState({ data: snap.exists() ? ({ id: snap.id, ...snap.data() } as T) : null, loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.path]);
  return state;
}
