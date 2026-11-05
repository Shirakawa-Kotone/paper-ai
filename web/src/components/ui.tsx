import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons.tsx';

/* --------------------------------- Toast --------------------------------- */

type ToastKind = 'ok' | 'bad' | 'info';
type ToastItem = { id: number; kind: ToastKind; message: string };

const ToastCtx = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-2), { id, kind, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === 'bad' ? 6000 : 3200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'ok' ? 'ok' : t.kind === 'bad' ? 'bad' : ''}`}>
            <Icon name={t.kind === 'ok' ? 'check-circle' : t.kind === 'bad' ? 'alert' : 'spark'} size={15} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* --------------------------------- Modal --------------------------------- */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* --------------------------------- Badge --------------------------------- */

type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'accent';

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`badge ${tone}`}>
      <i className="dot" />
      {children}
    </span>
  );
}

/* -------------------------------- Progress -------------------------------- */

export function Progress({ value, total, ok }: { value: number; total: number; ok?: boolean }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div className={`progress ${ok ? 'ok' : ''}`} role="progressbar" aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/* --------------------------------- Empty --------------------------------- */

export function Empty({
  icon = 'file',
  title,
  desc,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="icon-ring">
        <Icon name={icon} size={20} />
      </div>
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {action}
    </div>
  );
}

export function Spinner({ light }: { light?: boolean }) {
  return <span className={`spinner ${light ? 'light' : ''}`} />;
}

export function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="label">
        {label}
        {optional && <span className="opt">（可选）</span>}
      </div>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/* -------------------------------- Confirm -------------------------------- */

export function useConfirm() {
  const [state, setState] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null);

  const confirm = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => setState({ message, resolve }));
  }, []);

  const view = useMemo(
    () =>
      state ? (
        <Modal
          open
          title="请确认"
          onClose={() => {
            state.resolve(false);
            setState(null);
          }}
          footer={
            <>
              <button
                className="btn"
                onClick={() => {
                  state.resolve(false);
                  setState(null);
                }}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  state.resolve(true);
                  setState(null);
                }}
              >
                确定
              </button>
            </>
          }
        >
          <p style={{ lineHeight: 1.8 }}>{state.message}</p>
        </Modal>
      ) : null,
    [state],
  );

  return { confirm, view };
}
