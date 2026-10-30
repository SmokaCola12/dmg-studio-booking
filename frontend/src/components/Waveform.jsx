import { memo } from 'react';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fake audio waveform, the same every render for the same seed — the texture of a recorded clip. */
export const Waveform = memo(function Waveform({ seed = 1, bars = 24 }) {
  const rand = mulberry32(seed * 7919 + bars);
  const rects = [];
  let level = 0.5;
  for (let i = 0; i < bars; i++) {
    // Random walk keeps it looking like music rather than noise.
    level = Math.min(1, Math.max(0.12, level + (rand() - 0.5) * 0.55));
    const h = level * 18;
    rects.push(<rect key={i} x={i * 3 + 0.5} y={10 - h / 2} width={1.6} height={h} rx={0.8} />);
  }
  return (
    <svg className="waveform" viewBox={`0 0 ${bars * 3} 20`} preserveAspectRatio="none" aria-hidden="true">
      {rects}
    </svg>
  );
});
