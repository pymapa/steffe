import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

interface Options {
  /** localStorage key the size is remembered under. */
  key: string;
  initial: number;
  min: number;
  max: number;
  /** px: an absolute column width. %: a share of the container's content box. */
  unit: 'px' | '%';
  /** 1 when dragging right grows the column (a left-hand column), -1 when it shrinks it. */
  dir: 1 | -1;
}

/**
 * A column size the user can drag. Spread `handleProps` on a `.resize-handle`
 * element that is a direct child of the grid/flex container holding the
 * column; the container's content width is what % sizes are relative to.
 * Double-clicking the handle restores the default.
 */
export function useResizable({ key, initial, min, max, unit, dir }: Options) {
  const storageKey = `steffe.size.${key}`;
  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);
  const [value, setValue] = useState(() => clamp(load(storageKey) ?? initial));
  const valueRef = useRef(value);
  valueRef.current = value;

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const container = handle.parentElement;
    if (!container) return;
    const cs = getComputedStyle(container);
    const contentWidth = container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const scale = unit === '%' ? 100 / Math.max(1, contentWidth) : 1;
    const startX = e.clientX;
    const start = valueRef.current;
    let latest = start;

    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      latest = clamp(start + (ev.clientX - startX) * dir * scale);
      setValue(latest);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing');
      save(storageKey, latest);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const onDoubleClick = () => {
    setValue(initial);
    save(storageKey, null);
  };

  return {
    value,
    /** The value with its unit, for a CSS custom property. */
    css: `${value}${unit}`,
    handleProps: {
      onPointerDown,
      onDoubleClick,
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      title: 'Drag to resize · double-click to reset',
    },
  };
}

function load(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function save(key: string, v: number | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(v * 10) / 10));
  } catch {
    // remembered sizes are a convenience
  }
}
