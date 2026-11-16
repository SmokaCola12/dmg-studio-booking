import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

/**
 * "Inside the studio" grid. Tap a tile and it grows out of its place to the middle of the screen,
 * with the rest of the page dimmed behind it. Once it has landed, left and right arrows
 * (and the arrow keys, and a swipe) step through the photos and loop round at either end.
 *
 * items: [{ key, src?, alt?, label? }]. Without src the tile is a "Photo to come" placeholder.
 */

const DEFAULT_RATIO = 3 / 2;

function target(ratio) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxW = Math.min(vw - 24, 1100);
  const maxH = vh - (vw < 640 ? 190 : 170);
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  return { left: (vw - w) / 2, top: (vh - h) / 2 - 10, width: w, height: h };
}

export function Gallery({ items }) {
  const tiles = useRef([]);
  const [open, setOpen] = useState(null); // index of the photo being viewed, or null
  const [phase, setPhase] = useState('closed'); // closed | from | open | to
  const [box, setBox] = useState(null);
  const [ratios, setRatios] = useState({});
  const opener = useRef(null);
  const touchX = useRef(null);
  const closeBtn = useRef(null);

  const count = items.length;

  const openAt = (i) => {
    const el = tiles.current[i];
    if (!el) return;
    const r = el.getBoundingClientRect();
    opener.current = el;
    setBox({ left: r.left, top: r.top, width: r.width, height: r.height });
    setOpen(i);
    setPhase('from');
  };

  // Next frame after mounting at the tile's rectangle: move to the enlarged rectangle.
  useLayoutEffect(() => {
    if (phase !== 'from') return undefined;
    const id = requestAnimationFrame(() => {
      setBox(target(ratios[open] || DEFAULT_RATIO));
      setPhase('open');
    });
    return () => cancelAnimationFrame(id);
  }, [phase, open, ratios]);

  const close = useCallback(() => {
    if (open === null) return;
    const el = tiles.current[open];
    opener.current = el;
    if (el) {
      const r = el.getBoundingClientRect();
      setBox({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    setPhase('to');
  }, [open]);

  const finish = () => {
    if (phase === 'to') {
      setPhase('closed');
      setOpen(null);
      opener.current?.focus({ preventScroll: true });
    }
  };

  const step = useCallback(
    (d) => {
      if (open === null || count < 2) return;
      const next = (open + d + count) % count;
      setOpen(next);
      setBox(target(ratios[next] || DEFAULT_RATIO));
    },
    [open, count, ratios]
  );

  // Keep the enlarged photo fitted when the window changes, or once the real picture size is known.
  useEffect(() => {
    if (phase !== 'open') return undefined;
    const fit = () => setBox(target(ratios[open] || DEFAULT_RATIO));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [phase, open, ratios]);

  useEffect(() => {
    if (open === null) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, close, step]);

  useEffect(() => {
    if (phase === 'open') closeBtn.current?.focus({ preventScroll: true });
  }, [phase]);

  const current = open === null ? null : items[open];
  const landed = phase === 'open';

  return (
    <>
      <div className="gallery">
        {items.map((g, i) => (
          <figure key={g.key} className={`gallery-item${g.src ? '' : ' gallery-placeholder'}`}>
            <button
              type="button"
              className="gallery-open"
              ref={(el) => {
                tiles.current[i] = el;
              }}
              onClick={() => openAt(i)}
              aria-label={`Enlarge photo: ${g.alt || g.label}`}
              style={{ visibility: open === i && phase !== 'closed' ? 'hidden' : undefined }}
            >
              {g.src ? (
                <img src={g.src} alt="" loading="lazy" />
              ) : (
                <>
                  <span className="label">Photo to come</span>
                  <span className="gallery-cap">{g.label}</span>
                </>
              )}
            </button>
          </figure>
        ))}
      </div>

      {current && (
        <div
          className={`lb${landed ? ' is-open' : ''}${phase === 'to' ? ' is-closing' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label="Studio photos"
          onTouchStart={(e) => {
            touchX.current = e.touches[0].clientX;
          }}
          onTouchEnd={(e) => {
            if (touchX.current === null || !landed) return;
            const dx = e.changedTouches[0].clientX - touchX.current;
            touchX.current = null;
            if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
          }}
        >
          <div className="lb-backdrop" onClick={close} />
          <div
            className="lb-card"
            style={box}
            onTransitionEnd={(e) => {
              if (e.target === e.currentTarget && e.propertyName === 'width') finish();
            }}
          >
            {current.src ? (
              <img
                key={current.key}
                src={current.src}
                alt={current.alt || ''}
                draggable="false"
                onLoad={(e) => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                  if (w && h) setRatios((r) => (r[open] ? r : { ...r, [open]: w / h }));
                }}
              />
            ) : (
              <div className="lb-placeholder">
                <span className="label">Photo to come</span>
                <strong>{current.label}</strong>
              </div>
            )}
          </div>

          <div className="lb-ui" aria-hidden={!landed}>
            <button ref={closeBtn} type="button" className="lb-btn lb-close" onClick={close} aria-label="Close">
              <X aria-hidden="true" />
            </button>
            {count > 1 && (
              <>
                <button type="button" className="lb-btn lb-prev" onClick={() => step(-1)} aria-label="Previous photo">
                  <ChevronLeft aria-hidden="true" />
                </button>
                <button type="button" className="lb-btn lb-next" onClick={() => step(1)} aria-label="Next photo">
                  <ChevronRight aria-hidden="true" />
                </button>
              </>
            )}
            <p className="lb-caption" aria-live="polite">
              {current.alt || current.label ? <span>{current.alt || current.label}</span> : null}
              {count > 1 && (
                <span className="lb-count">
                  {open + 1} / {count}
                </span>
              )}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
