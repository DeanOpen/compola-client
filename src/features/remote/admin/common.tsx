// Shared pieces of the native server admin pages (Settings › Compola Server › Quản trị máy chủ).

import { ChevronLeft } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { errorText } from '../../../engine/serverAdmin';
import { Spinner } from '../../../ui/Spinner';

/** Loads once (and on `reload`); keeps the last data while reloading. */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `load` is fixed for the page's lifetime.
  const reload = useCallback(
    () =>
      load()
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => setError(errorText(e))),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

/** Runs a server call; a failure becomes the page's error line (the server's Vietnamese text, e.g. a 409). */
export function useAction() {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (call: () => Promise<unknown>, then?: () => unknown): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    try {
      await call();
      await then?.();
      return true;
    } catch (e) {
      setProblem(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { problem, setProblem, busy, run };
}

export function Problem({ text }: { text: string | null }) {
  return text ? (
    <div className="st-auto-error" role="alert">
      {text}
    </div>
  ) : null;
}

export function Loading({ error }: { error: string | null }) {
  if (error) return <Problem text={error} />;
  return (
    <div className="st-auto-loading">
      <Spinner size={18} />
    </div>
  );
}

/** "‹ Compola Server" above a sub-page, with its title. */
export function BackBar({ title, onBack, action }: { title: string; onBack: () => void; action?: ReactNode }) {
  return (
    <div className="sa-back">
      <button className="sa-back-button" onClick={onBack}>
        <ChevronLeft size={16} /> Quản trị máy chủ
      </button>
      <span className="sa-back-title">{title}</span>
      {action && <span className="sa-back-action">{action}</span>}
    </div>
  );
}

export const shortId = (id: string | null | undefined) => {
  const t = (id ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
  return t ? `#${t}` : '';
};

const fold = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');

/** Accent- and case-insensitive match of `query` in any of `fields`. */
export const matches = (query: string, ...fields: (string | null | undefined)[]) => {
  const q = fold(query.trim());
  return !q || fields.some((f) => f && fold(f).includes(q));
};
