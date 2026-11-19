import { useEffect } from 'react';

interface Props {
  images: { src: string; name: string }[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Names of the images the user has chosen; with onToggleChosen, shows a Choose toggle (Enter). */
  chosen?: string[];
  onToggleChosen?: (name: string) => void;
}

/** Full-size image viewer over the page. Esc closes, ←/→ page through, Enter chooses. */
export function ImageLightbox({ images, index, onIndex, onClose, chosen, onToggleChosen }: Props) {
  const count = images.length;
  const image = images[index];
  const isChosen = !!image && !!chosen?.includes(image.name);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && count > 1) onIndex((index - 1 + count) % count);
      else if (e.key === 'ArrowRight' && count > 1) onIndex((index + 1) % count);
      else if (e.key === 'Enter' && onToggleChosen && image) {
        e.preventDefault();
        onToggleChosen(image.name);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, count, onIndex, onClose, image, onToggleChosen]);

  if (!image) return null;
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name" title={image.name}>{image.name}</span>
        {count > 1 && <span className="muted">{index + 1} / {count}</span>}
        {onToggleChosen && (
          <button className={isChosen ? 'primary' : ''} title="Choose this design (Enter)" onClick={() => onToggleChosen(image.name)}>
            {isChosen ? '✓ Chosen' : 'Choose this'}
          </button>
        )}
        <a className="button-link" href={image.src} target="_blank" rel="noreferrer" title="Open in a new tab">↗</a>
        <button onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      {count > 1 && (
        <button className="lightbox-nav prev" title="Previous (←)"
          onClick={(e) => { e.stopPropagation(); onIndex((index - 1 + count) % count); }}>‹</button>
      )}
      <img src={image.src} alt={image.name} className={isChosen ? 'chosen' : undefined} onClick={(e) => e.stopPropagation()} />
      {count > 1 && (
        <button className="lightbox-nav next" title="Next (→)"
          onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % count); }}>›</button>
      )}
    </div>
  );
}
