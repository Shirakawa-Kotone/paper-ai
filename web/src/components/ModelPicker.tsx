import { useMemo, useState } from 'react';
import { Icon } from '../icons.tsx';

export type ModelOption = { id: string; vision: boolean };

/**
 * 模型选择框：既是输入框，也是"半个搜索框"。
 *  - 有匹配：下拉里显示（带"图片"标记）
 *  - 没匹配：提示"按未公开模型使用"，照样能填
 */
export function ModelPicker({
  value,
  onChange,
  options,
  placeholder,
  visionOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ModelOption[];
  placeholder?: string;
  visionOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const pool = useMemo(
    () => (visionOnly ? options.filter((o) => o.vision) : options),
    [options, visionOnly],
  );

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return pool.slice(0, 10);
    const starts = pool.filter((o) => o.id.toLowerCase().startsWith(q));
    const includes = pool.filter((o) => !o.id.toLowerCase().startsWith(q) && o.id.toLowerCase().includes(q));
    return [...starts, ...includes].slice(0, 10);
  }, [pool, value]);

  const exact = pool.some((o) => o.id.toLowerCase() === value.trim().toLowerCase());

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        className="input"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter' && open && matches[active]) {
            e.preventDefault();
            choose(matches[active].id);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />

      {open && (pool.length > 0 || value.trim()) && (
        <div className="model-menu">
          {matches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className={`model-item ${i === active ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(m.id);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="mono" style={{ fontSize: 12.5 }}>
                {m.id}
              </span>
              {m.vision && <span className="model-flag">图片</span>}
            </button>
          ))}

          {!matches.length && value.trim() && (
            <div className="model-empty">
              <Icon name="spark" size={13} />
              列表里没有「{value.trim()}」，按未公开模型使用（可以直接保留）
            </div>
          )}

          {matches.length > 0 && value.trim() && !exact && (
            <div className="model-empty">没有完全匹配的，当前填的会被当成自定义模型名</div>
          )}
        </div>
      )}
    </div>
  );
}
