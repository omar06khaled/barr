import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { api, ApiError } from './api';

/** Fetch on focus (+ optional polling). Real-time enough for F2/F3: push triggers refetch, and we poll while visible. */
export function useQuery<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { setData(await api<T>(path)); setError(null); } catch (e) { setError(e instanceof ApiError ? e.code : 'error'); } finally { setLoading(false); }
  }, [path]);
  useFocusEffect(useCallback(() => { void load(); if (!pollMs) return; const id = setInterval(() => void load(), pollMs); return () => clearInterval(id); }, [load, pollMs]));
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load };
}
