import { useEffect, useRef } from 'react';

export default function VideoModal({ open, onClose }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!open && videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
    if (open && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [open]);

  return (
    <div className={`modal-backdrop video-modal ${open ? 'is-open' : ''}`} onClick={onClose}>
      <div className="video-modal-inner" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <video
          ref={videoRef}
          src="/artefacts/book-preview.mp4"
          poster="/artefacts/book.png"
          controls
          playsInline
          preload="metadata"
        >
          Your browser does not support the video tag.
        </video>
        <div className="video-caption">
          <div className="eyebrow">Preview · A Multiverse of Love</div>
          <p>A glimpse inside the book.</p>
        </div>
      </div>
    </div>
  );
}
