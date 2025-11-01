import { useEffect } from 'react';

const Music = () => {
  useEffect(() => {
    // Particle animation
    const createParticles = () => {
      const container = document.getElementById('particles');
      if (!container) return;
      
      container.innerHTML = '';
      for (let i = 0; i < 50; i++) {
        const particle = document.createElement('div');
        particle.classList.add('particle');
        particle.style.left = Math.random() * 100 + '%';
        particle.style.top = Math.random() * 100 + '%';
        particle.style.animationDelay = Math.random() * 3 + 's';
        particle.style.animationDuration = (Math.random() * 3 + 2) + 's';
        container.appendChild(particle);
      }
    };
    createParticles();
  }, []);

  return (
    <>
      <div className="particles" id="particles"></div>

      <header className="header breathing-element" style={{'--delay': '0s'}}>
        <h1>
          <div className="card-inner">Music</div>
        </h1>
      </header>

      <section className="intro breathing-element" style={{'--delay': '0.5s'}}>
        <p>
          In the quiet alchemy of creation, artists weave their souls into melodies,
          turning whispers of the divine into symphonies that echo in our hearts.
          Through every note and lyric, they share sacred messages—reminders of
          love's boundless light, the universe's gentle rhythm, and the spirit's
          eternal dance. In their music, we find not just sound, but a bridge to
          the infinite, inviting us to listen, feel, and awaken together.
        </p>
      </section>

      <section className="video-grid">
        <div className="video-card breathing-element" style={{'--delay': '1s'}}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=W0DM5lcj6mw" target="_blank" rel="noopener noreferrer">
              <img src="https://i.scdn.co/image/ab67616d0000b2735675e83f707f1d7271e5cf8a" alt="Imagine Dragons - Believer" />
            </a>
            <h3>Believer</h3>
            <p>Imagine Dragons</p>
            <a href="https://www.youtube.com/watch?v=W0DM5lcj6mw" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{'--delay': '1.5s'}}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=w3viBe2Q0P8" target="_blank" rel="noopener noreferrer">
              <img src="https://i.scdn.co/image/ab67616d0000b2735675e83f707f1d7271e5cf8a" alt="Imagine Dragons - Radioactive" />
            </a>
            <h3>Radioactive</h3>
            <p>Imagine Dragons</p>
            <a href="https://www.youtube.com/watch?v=w3viBe2Q0P8" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{'--delay': '2s'}}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=V5M2WZiAy6k" target="_blank" rel="noopener noreferrer">
              <img src="https://i.scdn.co/image/ab67616d0000b2735675e83f707f1d7271e5cf8a" alt="Imagine Dragons - Natural" />
            </a>
            <h3>Natural</h3>
            <p>Imagine Dragons</p>
            <a href="https://www.youtube.com/watch?v=V5M2WZiAy6k" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>
      </section>

      <section className="video-grid">
        <div className="video-card breathing-element" style={{'--delay': '2.5s'}}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=KnzmnTagueM&list=RDKnzmnTagueM&start_radio=1" target="_blank" rel="noopener noreferrer">
              <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTFzmz3hRTEAqy84317sz6e4yoqd9r-TxxHpw&s" alt="Mr Traumatik - Ark of the Covenant" />
            </a>
            <h3>Jericho</h3>
            <p>Iniko</p>
            <a href="https://www.youtube.com/watch?v=KnzmnTagueM&list=RDKnzmnTagueM&start_radio=1" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{'--delay': '3s'}}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=fyxHLnDODbA" target="_blank" rel="noopener noreferrer">
              <img src="https://i.ebayimg.com/images/g/pxwAAOSwH-Bf6JFx/s-l400.jpg" alt="Yannick Noah - Simon Papa Tara" />
            </a>
            <h3>Simon Papa Tara</h3>
            <p>Yannick Noah</p>
            <a href="https://www.youtube.com/watch?v=fyxHLnDODbA" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{'--delay': '3.5s'}}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=1EQzCoF7uA8" target="_blank" rel="noopener noreferrer">
              <img src="https://encrypted-tbn1.gstatic.com/images?q=tbn:ANd9GcTDl-oQaOUnpfQz5U73dt43tGTpScvTcOMEtwiqKeALQ-q2oLTW0S3kY-M4v9UqvoZ3s3a0fUWYvxQGP2HbSM441dPY_A0pgJYGRhiymw" alt="Mumford & Sons - Awake My Soul" />
            </a>
            <h3>Awake My Soul</h3>
            <p>Mumford & Sons</p>
            <a href="https://www.youtube.com/watch?v=1EQzCoF7uA8" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>
      </section>

      <div style={{width: '100%', marginTop: '40px', paddingBottom: '0'}}>
        <iframe data-testid="embed-iframe" style={{borderRadius: '12px'}} src="https://open.spotify.com/embed/track/21KmD4GGubAmJnZFwRsHCG?utm_source=generator" width="100%" height="352" frameBorder="0" allowFullScreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>
      </div>
    </>
  );
};

export default Music;
