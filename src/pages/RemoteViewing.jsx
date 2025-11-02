import { useEffect } from 'react';

const RemoteViewing = () => {
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

      <header className="header breathing-element" style={{"--delay": "0s"}}>
        <h1>
          <div className="card-inner">Remote Viewing</div>
        </h1>
      </header>

      <section className="intro breathing-element" style={{"--delay": "0.5s"}}>
        <p>Remote viewing is a technique where individuals use extrasensory perception to perceive distant or hidden objects, places, or events without physical interaction. It is often linked to consciousness theories suggesting that human awareness can transcend physical boundaries, tapping into a universal or collective consciousness.</p>
      </section>

      <section className="explore-intro breathing-element" style={{"--delay": "1s"}}>
        <p>Open your mind and explore the trippy realm of Remote Viewing through these mind-bending videos.</p>
        <p>Dive deep into the cosmic rabbit hole and awaken your third eye!</p>
      </section>

      <section className="video-grid">
        <div className="video-card">
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=XRTon6qgVws" target="_blank" rel="noopener noreferrer">
              <img src="https://i.ytimg.com/vi/XRTon6qgVws/hq720.jpg?sqp=-oaymwEhCK4FEIIDSFryq4qpAxMIARUAAAAAGAElAADIQj0AgKJD&rs=AOn4CLBSU92zTifqgIvMZG4BjwfYKyb50g" alt="CIA remote viewing program" />
            </a>
            <h3>CIA's Project Stargate</h3>
            <p>The Shawn Ryan Show - Joe McMoneagle</p>
            <a href="https://www.youtube.com/watch?v=XRTon6qgVws" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card">
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=Gf_tKn9TaP8" target="_blank" rel="noopener noreferrer">
              <img src="https://m.media-amazon.com/images/M/MV5BN2QyMjUwZTctNTU2OS00MjhkLWJkOTAtZTVhZDA2ZDZhMGU5XkEyXkFqcGc@._V1_.jpg" alt="Joe Rogan Experience - Hal Puthoff" />
            </a>
            <h3>Stanford Scientist</h3>
            <p>Joe Rogan Experience — Hal Puthoff</p>
            <a href="https://www.youtube.com/watch?v=Gf_tKn9TaP8" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>
      </section>

      <div className="footer">
        <p>Visit <a href="https://www.monroeinstitute.org/" target="_blank" rel="noopener noreferrer" style={{color: '#00FFFF', textDecoration: 'none'}}>Monroe Institute</a></p>
      </div>
    </>
  );
};

export default RemoteViewing;
