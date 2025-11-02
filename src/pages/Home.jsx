import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

const Home = () => {
  const videoBackgroundRef = useRef(null);
  const playerRef = useRef(null);
  
  useEffect(() => {
    // Matrix text animation
    const matrixText = document.getElementById('matrix-text');
    
    const animateText = () => {
      const sequence = [
        { text: 'Wake up, Neo...', typeClass: 'typing-neo', deleteClass: 'deleting-neo', typeDuration: 3000, deleteDuration: 3690 }
      ];
      
      const displayWord = (index) => {
        if (index >= sequence.length) { 
          setTimeout(animateText, 600); 
          return; 
        }
        const { text, typeClass, deleteClass, typeDuration, deleteDuration } = sequence[index];
        matrixText.textContent = text;
        matrixText.className = `matrix-text ${typeClass}`;
        setTimeout(() => {
          matrixText.className = `matrix-text ${deleteClass}`;
          setTimeout(() => displayWord(index + 1), deleteDuration);
        }, typeDuration);
      };
      displayWord(0);
    };
    
    setTimeout(animateText, 3900);

    // YouTube video background
    const prefersNoVideo =
      matchMedia('(max-width: 768px)').matches ||
      matchMedia('(pointer: coarse)').matches;

    if (!prefersNoVideo) {
      const tag = document.createElement('script');
      tag.src = "https://www.youtube.com/iframe_api";
      tag.onload = () => {
        window.onYouTubeIframeAPIReady = () => {
          if (prefersNoVideo) {
            if (videoBackgroundRef.current) {
              videoBackgroundRef.current.style.display = 'none';
            }
            return;
          }

          window.player = new window.YT.Player('player', {
            videoId: '6ouG6L-2L3Q',
            playerVars: {
              autoplay: 1,
              controls: 0,
              mute: 1,
              loop: 1,
              playlist: '6ouG6L-2L3Q',
              showinfo: 0,
              modestbranding: 1,
              playsinline: 1
            },
            events: { 
              'onReady': (event) => {
                if (videoBackgroundRef.current) {
                  videoBackgroundRef.current.classList.add('fade-in');
                }
                event.target.mute();
                event.target.playVideo().catch(() => {});

                const resizeVideo = () => {
                  const video = document.getElementById('player');
                  if (!video) return;
                  const aspectRatio = 16 / 9;
                  const windowRatio = window.innerWidth / window.innerHeight;
                  if (windowRatio > aspectRatio) {
                    video.style.width = '120vw';
                    video.style.height = `${120 * windowRatio / aspectRatio}vw`;
                  } else {
                    video.style.width = `${120 * aspectRatio / windowRatio}vh`;
                    video.style.height = '120vh';
                  }
                };
                resizeVideo();
                window.addEventListener('resize', resizeVideo);
              }
            }
          });
        };
      };
      document.head.appendChild(tag);
    }

    // Button fade-in animation
    const buttons = document.querySelectorAll('.trippy-button');
    buttons.forEach(btn => {
      void btn.offsetWidth;
      btn.classList.add('fade-in');
    });
  }, []);

  return (
    <>
      <div id="video-background" ref={videoBackgroundRef}>
        <div id="player"></div>
      </div>
      <div id="matrix-text" className="matrix-text"></div>

      <div id="button-container">
        <div className="row1">
          <Link className="trippy-button" to="/phd/music">Music</Link>
          <Link className="trippy-button" to="/phd/psychedelics">Psychedelics</Link>
          <Link className="trippy-button" to="/phd/telepathy">Telepathy</Link>
          <Link className="trippy-button" to="/phd/mindsight">Mindsight</Link>
          <Link className="trippy-button" to="/phd/remote-viewing">Remote Viewing</Link>
        </div>

        <div className="row2">
          <Link className="trippy-button" to="/phd/out-of-body-experience">Out of Body Experience</Link>
          <Link className="trippy-button" to="/phd/non-human-intelligence">Non Human Intelligence</Link>
          <Link className="trippy-button" to="/phd/multiverse">Multiverse</Link>
          <Link className="trippy-button" to="/phd/infinity">Infinity</Link>
        </div>

        <div id="egg-container">
          <Link id="easter-egg" className="trippy-button" to="/phd/easter-egg">🥚</Link>
        </div>
      </div>
    </>
  );
};

export default Home;
