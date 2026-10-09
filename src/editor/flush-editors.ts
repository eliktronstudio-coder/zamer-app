const handlers = new Set<() => Promise<boolean>>();
export function registerEditorFlush(handler: () => Promise<boolean>) {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
export async function flushEditors() {
  return (await Promise.all([...handlers].map((handler) => handler()))).every(
    Boolean,
  );
}
