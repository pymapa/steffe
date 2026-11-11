import { useEffect } from 'react';

interface Props {
  images: { src: string; name: string }[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

/** Full-size image viewer over the page. Esc closes, ←/→ page through. */
export function ImageLightbox({ images, index, onIndex, onClose }: Props) {
  const count = images.length;
  const image = images[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && count > 1) onIndex((index - 1 + count) % count);
      else if (e.key === 'ArrowRight' && count > 1) onIndex((index + 1) % count);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, count, onIndex, onClose]);

  if (!image) return null;
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name" title={image.name}>{image.name}</span>
        {count > 1 && <span className="muted">{index + 1} / {count}</span>}
        <a className="button-link" href={image.src} target="_blank" rel="noreferrer" title="Open in a new tab">↗</a>
        <button onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      {count > 1 && (
        <button className="lightbox-nav prev" title="Previous (←)"
          onClick={(e) => { e.stopPropagation(); onIndex((index - 1 + count) % count); }}>‹</button>
      )}
      <img src={image.src} alt={image.name} onClick={(e) => e.stopPropagation()} />
      {count > 1 && (
        <button className="lightbox-nav next" title="Next (→)"
          onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % count); }}>›</button>
      )}
    </div>
  );
}
