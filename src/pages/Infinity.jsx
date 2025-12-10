import { useEffect } from 'react';

const Infinity = () => {
  useEffect(() => {
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

      <header className="header breathing-element" style={{ "--delay": "0s" }}>
        <h1>
          <div className="card-inner">Infinity</div>
        </h1>
      </header>

      <section className="intro breathing-element" style={{ "--delay": "0.5s" }}>
        <p>The universe spirals inward and outward, a kaleidoscope of endless mirrors.
          Each atom hums with the echo of infinity, a fractal dance where every edge births a new universe, splitting and folding into itself.
          Stars collapse, yet their dust weaves galaxies anew—patterns repeating, never the same, a cosmic mandala.
          You are a fragment of this fractal, a fleeting note in an eternal symphony, where the infinite whispers: there is no end, only deeper layers of wonder.</p>
      </section>

      <section className="explore-intro breathing-element" style={{ "--delay": "1s" }}>
        <p>Open your mind and explore the trippy realm of Infinity through these mind-bending videos.</p>
        <p>Dive deep into the cosmic rabbit hole and awaken your third eye!</p>
      </section>

      <div className="symbol-container" style={{ textAlign: 'center', marginBottom: '3rem' }}>
        <img src="/artefacts/flower_of_life.svg" alt="Flower of Life" className="flower-of-life" />
      </div>

      <section className="video-grid">
        <div className="video-card breathing-element" style={{ '--delay': '1.5s' }}>
          <div className="card-inner">
            <a href="https://www.netflix.com/be-en/title/81408994" target="_blank" rel="noopener noreferrer">
              <img src="https://images.squarespace-cdn.com/content/v1/5b144601d274cbcb6220ee14/b51443ad-5b37-469b-9a01-d8bd6aea6e9d/CloudsAreNotSpheres-ThumbClean.jpg" alt="Clouds Are Not Spheres" />
            </a>
            <h3>Clouds Are Not Spheres</h3>
            <p>The life and theories of Benoit Mandelbrot</p>
            <a href="https://www.netflix.com/be-en/title/81408994" target="_blank" rel="noopener noreferrer">Watch on Netflix</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{ '--delay': '2.0s' }}>
          <div className="card-inner">
            <a href="https://www.netflix.com/be-en/title/81408990" target="_blank" rel="noopener noreferrer">
              <img src="https://m.media-amazon.com/images/S/pv-target-images/a672451a7eb628477681a2909b6aa2f63c28e80150c474f1565b4a45e5fb3e00.jpg" alt="The Colours of Infinity" />
            </a>
            <h3>The Colours of Infinity</h3>
            <p>Fractals and mathematics in nature</p>
            <p>Free will - Thumbprint of GOD</p>
            <a href="https://www.netflix.com/be-en/title/81408990" target="_blank" rel="noopener noreferrer">Watch on Netflix</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{ '--delay': '2.5s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/playlist?list=PLWXeU3K0sz2Xk62ry_rLeRKCKhXRzEd9n" target="_blank" rel="noopener noreferrer">
              <img src="https://i.ytimg.com/vi/IYtWsrc6Sps/hq720.jpg?sqp=-oaymwEhCK4FEIIDSFryq4qpAxMIARUAAAAAGAElAADIQj0AgKJD&rs=AOn4CLAXyd8qcmZFhgGO6cs4cVV2R-dpuA" alt="Dare to do. Motivation" />
            </a>
            <h3>Dare to do. Motivation</h3>
            <p>The Secret Power Of The Universe</p>
            <a href="https://www.youtube.com/playlist?list=PLWXeU3K0sz2Xk62ry_rLeRKCKhXRzEd9n" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>
      </section>

      <section className="video-grid">
        <div className="video-card breathing-element" style={{ '--delay': '3.0s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=Em3XplqnoF4" target="_blank" rel="noopener noreferrer">
              <img src="https://thumbs.dreamstime.com/b/white-dove-olive-branch-hovering-above-earth-globe-radiant-light-international-day-peace-world-un-global-celebration-354468401.jpg" alt="Transcendental Meditation" />
            </a>
            <h3>Transcendental Meditation</h3>
            <p>The merging of Science &amp; Spirituality and emerging Peace 🕊️</p>
            <a href="https://www.youtube.com/watch?v=Em3XplqnoF4" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>


      </section>

      <div className="symbol-container" style={{ textAlign: 'center', marginTop: '3rem', marginBottom: '3rem' }}>
        <img src="/artefacts/mandelbrot.svg" alt="Mandelbrot" className="mandelbrot-icon" />
      </div>

      <div className="footer">
        <p>
          Vibe coded with{' '}
          <a href="https://x.ai/" target="_blank" rel="noopener noreferrer">x.AI</a> Grok{' '}
          <span className="heart">❤️</span>
        </p>
      </div>
    </>
  );
};

export default Infinity;
