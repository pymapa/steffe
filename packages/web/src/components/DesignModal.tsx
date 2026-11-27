import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskQuestion } from '@steffe/shared';
import { api } from '../lib/api';
import { ImageLightbox } from './ImageLightbox';
import { Markdown } from './Markdown';

interface Props {
  task: Task;
  /** The design to show: the question it came with, pending or already answered. */
  design: TaskQuestion;
  open: boolean;
  onClose: () => void;
}

/**
 * A design in a window of its own: the orchestrator's summary, then each question with its own
 * screenshots. While the design is the task's pending question, the user answers it here
 * (approve, or tweaks, with the alternative picked in each either-or section); afterwards it is read only.
 * Stays mounted while closed, so a half-written answer and the choices survive closing it.
 */
export function DesignModal({ task, design, open, onClose }: Props) {
  const pending = task.question?.id === design.id;
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // The alternative picked in each either-or section (by section index); named in the answer.
  const [picks, setPicks] = useState<Record<number, string>>({});
  const images = useMemo(
    () =>
      (design.images ?? []).map((name) => ({
        name,
        src: `/api/tasks/${task.id}/artifacts/${encodeURIComponent(name)}`,
        caption: design.sections?.flatMap((sec) => sec.images).find((i) => i.name === name)?.caption,
      })),
    [task.id, design],
  );
  // Screenshots that are in no section (e.g. a design from before sections) follow at the end.
  const inSections = new Set(design.sections?.flatMap((sec) => sec.images.map((i) => i.name)));
  const looseImages = images.filter((img) => !inSections.has(img.name));

  useEffect(() => {
    setPicks({});
    setAnswer('');
    setError(null);
  }, [design.id]);
  useEffect(() => {
    if (!open) setLightbox(null);
  }, [open]);
  useEffect(() => {
    if (!open || lightbox !== null) return; // the lightbox takes Esc while it is up
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, lightbox, onClose]);

  if (!open) return null;

  const pickSections = (design.sections ?? []).map((sec, n) => ({ sec, n })).filter(({ sec }) => sec.pick);
  const picked = pickSections.filter(({ n }) => picks[n]);
  // "1. Where do filters go?" from a section's markdown, to name it in the answer.
  const title = (text: string) => (text.split('\n').find((l) => l.trim()) ?? '').replace(/[*_#`]/g, '').trim().slice(0, 100);
  const choices = picked.length
    ? `My choices:\n${picked
        .map(({ sec, n }) => {
          const caption = sec.images.find((i) => i.name === picks[n])?.caption;
          return `- ${title(sec.text)} → ${caption ? `${caption} ` : ''}(\`${picks[n]}\`)`;
        })
        .join('\n')}${picked.length < pickSections.length ? '\nWhere I picked nothing, go with your recommendation.' : ''}`
    : '';
  const send = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerTask(task.id, text);
      setAnswer('');
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const sendTweaks = () => send(choices ? `${choices}\n\n${answer}` : answer);

  return (
    <div className="modal-backdrop design-backdrop" onClick={onClose}>
      <div className="modal design-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{pending ? 'Design to review' : 'Design'}</h2>
          <span className="muted">
            {task.title} · {pending ? 'waiting for your answer' : `shown ${new Date(design.askedAt).toLocaleString()}`}
          </span>
          {design.links?.map((l) => (
            <a key={l.url} className="button-link" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
              {l.label} ↗
            </a>
          ))}
          <button onClick={onClose} title="Close (Esc)">✕</button>
        </header>
        <div className="design-body">
          <Markdown>{design.text}</Markdown>
          {design.sections?.map((sec, n) => (
            <section key={n} className="design-section">
              <Markdown>{sec.text}</Markdown>
              <div className="design-images">
                {sec.images.map((i) => {
                  const idx = images.findIndex((img) => img.name === i.name);
                  return (
                    <DesignImage key={i.name} image={{ ...images[idx], caption: i.caption }} onOpen={() => setLightbox(idx)}
                      picked={picks[n] === i.name}
                      onPick={pending && sec.pick ? () => setPicks((p) => {
                        const { [n]: was, ...rest } = p;
                        return was === i.name ? rest : { ...rest, [n]: i.name };
                      }) : undefined} />
                  );
                })}
              </div>
            </section>
          ))}
          {looseImages.length > 0 && (
            <section className="design-section">
              {!!design.sections?.length && <h3>Other screenshots</h3>}
              <div className="design-images">
                {looseImages.map((img) => (
                  <DesignImage key={img.name} image={img} onOpen={() => setLightbox(images.indexOf(img))} />
                ))}
              </div>
            </section>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        {pending && (
          <div className="input-row">
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2}
              placeholder="Tweaks you want, or approve as is…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && answer.trim()) void sendTweaks();
              }} />
            <button className="primary" disabled={busy || !answer.trim()} onClick={() => void sendTweaks()}>Request tweaks</button>
            <button className="primary" disabled={busy || !!answer.trim()}
              title={picked.length < pickSections.length ? 'Approve; where you picked nothing, the recommendation is used' : 'Approve the design'}
              onClick={() => void send(choices ? `I approve the design.\n\n${choices}` : 'I approve this design as shown.')}>
              {pickSections.length ? `Approve (${picked.length}/${pickSections.length} picked)` : 'Approve design'}
            </button>
          </div>
        )}
      </div>
      {lightbox !== null && (
        <div onClick={(e) => e.stopPropagation()}>
          <ImageLightbox images={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
        </div>
      )}
    </div>
  );
}

/**
 * A screenshot of a design: a thumbnail that opens the lightbox and its caption. With onPick it
 * is one of a section's alternatives, and the caption is a radio button.
 */
function DesignImage({ image, picked, onOpen, onPick }: {
  image: { name: string; src: string; caption?: string };
  picked?: boolean;
  onOpen: () => void;
  onPick?: () => void;
}) {
  const caption = <span className={image.caption ? undefined : 'muted'} title={image.name}>{image.caption || image.name}</span>;
  return (
    <span className={`design-image${picked ? ' chosen' : ''}`}>
      <button className="image-thumb" title={`${image.name} (click to enlarge)`} onClick={onOpen}>
        <img src={image.src} alt={image.caption || image.name} />
      </button>
      {onPick ? (
        <label className="design-image-caption pick">
          {/* onClick, not onChange: clicking the picked one again clears it. */}
          <input type="radio" checked={!!picked} onClick={onPick} onChange={() => {}} />
          {caption}
        </label>
      ) : (
        <span className="design-image-caption">{caption}</span>
      )}
    </span>
  );
}
