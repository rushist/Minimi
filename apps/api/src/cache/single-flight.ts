export function singleFlight<T>() {
  const pending = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const current = pending.get(key);
    if (current) return current;
    const next = Promise.resolve()
      .then(load)
      .finally(() => pending.delete(key));
    pending.set(key, next);
    return next;
  };
}
