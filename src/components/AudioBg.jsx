import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';

const AudioBg = forwardRef(function AudioBg(_, ref) {
  const audioRef = useRef(null);
  const [muted, setMuted] = useState(true);
  const [started, setStarted] = useState(false);
  const wasPlayingRef = useRef(false);

  useImperativeHandle(ref, () => ({
    pauseForVideo() {
      const a = audioRef.current;
      if (!a) return;
      wasPlayingRef.current = !muted && !a.paused;
      if (wasPlayingRef.current) a.pause();
    },
    resumeFromVideo() {
      const a = audioRef.current;
      if (!a || !wasPlayingRef.current) return;
      a.play().catch(() => {});
    },
  }));

  const toggle = async () => {
    const a = audioRef.current;
    if (!a) return;
    if (!started) {
      a.muted = false;
      a.volume = 0.35;
      try {
        await a.play();
        setStarted(true);
        setMuted(false);
      } catch (e) {}
    } else {
      if (muted) {
        a.muted = false;
        setMuted(false);
        if (a.paused) a.play().catch(() => {});
      } else {
        a.muted = true;
        setMuted(true);
      }
    }
  };

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = 0.35;
    a.muted = true;
    a.play().then(() => setStarted(true)).catch(() => {});
  }, []);

  return (
    <>
      <audio ref={audioRef} src="/artefacts/interstellar.mp3" loop preload="auto" />
      <button
        className={`audio-toggle ${muted ? '' : 'is-playing'}`}
        onClick={toggle}
        aria-label={muted ? 'Play Interstellar theme' : 'Mute Interstellar theme'}
        title={muted ? 'Play Interstellar theme' : 'Mute'}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          {muted ? (
            <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9v6h4l5 4V5L8 9H4z" />
              <line x1="16" y1="9" x2="22" y2="15" />
              <line x1="22" y1="9" x2="16" y2="15" />
            </g>
          ) : (
            <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9v6h4l5 4V5L8 9H4z" />
              <path d="M16 8c1.5 1.2 2.5 2.5 2.5 4s-1 2.8-2.5 4" />
              <path d="M19 5c2.5 1.8 4 4.2 4 7s-1.5 5.2-4 7" />
            </g>
          )}
        </svg>
        <span>{muted ? 'Play theme' : 'Now playing · Interstellar'}</span>
      </button>
    </>
  );
});

export default AudioBg;
