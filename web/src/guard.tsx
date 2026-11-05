import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

type GuardValue = {
  /** 当前页面有没有未保存的改动 */
  dirty: boolean;
  /** 页面把自己标脏/标干净 */
  setDirty: (d: boolean) => void;
  /** 页面注册一个"保存"动作，让弹窗能提供「保存并离开」 */
  registerSave: (fn: (() => Promise<boolean>) | null) => void;
  /** 供 App 调用：执行已注册的保存 */
  runSave: () => Promise<boolean>;
};

const GuardCtx = createContext<GuardValue>({
  dirty: false,
  setDirty: () => {},
  registerSave: () => {},
  runSave: async () => false,
});

export function LeaveGuardProvider({ children }: { children: React.ReactNode }) {
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);

  const setDirty = useCallback((d: boolean) => {
    dirtyRef.current = d;
    setDirtyState(d);
  }, []);

  const registerSave = useCallback((fn: (() => Promise<boolean>) | null) => {
    saveRef.current = fn;
  }, []);

  const runSave = useCallback(async () => {
    const fn = saveRef.current;
    if (!fn) return false;
    const ok = await fn();
    if (ok) setDirty(false);
    return ok;
  }, [setDirty]);

  // 关闭标签页 / 刷新时，浏览器弹原生确认
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const value = useMemo(
    () => ({ dirty, setDirty, registerSave, runSave }),
    [dirty, setDirty, registerSave, runSave],
  );

  return <GuardCtx.Provider value={value}>{children}</GuardCtx.Provider>;
}

export const useLeaveGuard = () => useContext(GuardCtx);
