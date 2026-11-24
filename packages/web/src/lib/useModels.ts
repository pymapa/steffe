import { useEffect, useState } from 'react';
import { api } from './api';

let cached: Promise<string[]> | null = null;

/** Model aliases a session can be started with or switched to. Fetched once. */
export function useModels(): string[] {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    cached ??= api.defaults().then((d) => d.models);
    let live = true;
    cached.then((m) => live && setModels(m)).catch(() => (cached = null));
    return () => {
      live = false;
    };
  }, []);
  return models;
}
