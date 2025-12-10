import { useEffect } from 'react';

const Telepathy = () => {
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

      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <header className="header breathing-element" style={{ '--delay': '0s' }}>
          <h1>
            <div className="card-inner">Telepathy</div>
          </h1>
        </header>

        <section className="intro breathing-element" style={{ '--delay': '0.5s' }}>
          <p>
            In a world that often dismisses the extraordinary as mere fantasy,
            <em> The Telepathy Tapes</em> explores the profound abilities of
            non-speakers with autism—individuals who have long been misunderstood
            and underestimated.
          </p>
        </section>

        <section className="explore-intro breathing-element" style={{ '--delay': '1s' }}>
          <p>Open your mind and explore the trippy realm of Telepathy through these mind-bending videos.</p>
          <p>Dive deep into the cosmic rabbit hole and awaken your third eye!</p>
        </section>

        <section className="video-grid">
          <div className="video-card breathing-element" style={{ '--delay': '1.5s' }}>
            <div className="card-inner">
              <a href="https://www.youtube.com/watch?v=mxLpiSuvOJk&list=PL6lsUJdGLFx7OGLRQCQfHQPWcMDPc5Ey" target="_blank" rel="noopener noreferrer">
                <img src="https://i.scdn.co/image/ab6765630000ba8a5eae6355858122d6e416ab7f" alt="The Telepathy Tapes" />
              </a>
              <h3>Telepathy Tapes</h3>
              <p>Ky Dickens explores the hidden realm of telepathy</p>
              <a href="https://www.youtube.com/watch?v=mxLpiSuvOJk&list=PL6lsUJdGLFx7OGLRQCQfHQPWcMDPc5Ey" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
            </div>
          </div>

          <div className="video-card breathing-element" style={{ '--delay': '2s' }}>
            <div className="card-inner">
              <a href="https://www.youtube.com/watch?v=fHp43kKxatM&t=3780s" target="_blank" rel="noopener noreferrer">
                <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTTKqJBSdVFawx7jUfhJiadpZSK3hUVBU9zLA&s" alt="Reality Check: NewsNation Deep Dive" />
              </a>
              <h3>Reality Check</h3>
              <p>
                Ross Coulthart discusses telepathy with Dr. Julia Mossbridge
                and Ky Dickens.
              </p>
              <a href="https://www.youtube.com/watch?v=fHp43kKxatM&t=3780s" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
            </div>
          </div>
        </section>

        <footer className="footer" style={{ marginTop: 'auto' }}>
          <p>Interstellar Psychology <span className="heart">❤️</span></p>
        </footer>
      </div>
    </>
  );
};

export default Telepathy;
