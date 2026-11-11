import { useCallback, useEffect, useState } from 'react';
import type { ProjectCatalog } from '@steffe/shared';
import { api } from './api';

/** Agents and skills (Steffe's and the project's) for the active project. */
export function useCatalog(projectId: string | null) {
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setCatalog(await api.getCatalog(projectId));
    } catch {
      setCatalog({ agents: [], skills: [] });
    }
  }, [projectId]);

  useEffect(() => {
    setCatalog(null);
    void reload();
  }, [reload]);

  return { catalog, reload };
}
