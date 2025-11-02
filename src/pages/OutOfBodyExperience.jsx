import { useEffect } from 'react';

const OutOfBodyExperience = () => {
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
          <div className="card-inner">Out of Body Experience</div>
        </h1>
      </header>

      <section className="intro breathing-element" style={{"--delay": "0.5s"}}>
        <p>Many report a renewed sense of purpose, reduced fear of death, and increased spirituality or belief in an afterlife. Some undergo personality changes, becoming more compassionate or altruistic, while others may struggle with integrating the experience, facing skepticism or existential questions. NDEs can reshape one's worldview, relationships, and priorities, often leading to lasting psychological and spiritual transformation.</p>
      </section>

      <section className="explore-intro breathing-element" style={{"--delay": "1s"}}>
        <p>Open your mind and explore the trippy realm of Out of Body Experiences through these mind-bending videos.</p>
        <p>Dive deep into cosmic the rabbit hole and awaken your third eye!</p>
      </section>

      <section className="video-grid">
        <div className="video-card">
          <div className="card-inner">
            <a href="https://www.youtube.com/@AnthonyCheneProduction/playlists" target="_blank" rel="noopener noreferrer">
              <img src="https://i.ytimg.com/vi/PgYO3VB6ubo/hqdefault.jpg" alt="Anthony Chene production" />
            </a>
            <h3>Anthony Chene production</h3>
            <p>Documentaries and interviews about Near Death Experiences</p>
            <a href="https://www.youtube.com/@AnthonyCheneProduction/playlists" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card">
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=_aHCQnpJWMo" target="_blank" rel="noopener noreferrer">
              <img src="https://i.ytimg.com/vi/_aHCQnpJWMo/hq720.jpg?sqp=-oaymwEhCK4FEIIDSFryq4qpAxMIARUAAAAAGAElAADIQj0AgKJD&rs=AOn4CLBi8FuFUwyEUORudIAdQqytAAX47A" alt="The nature of reality With Darius J. Wright" />
            </a>
            <h3>The nature of reality</h3>
            <p>Master Out of Body Experiencer Darius J. Wright</p>
            <a href="https://www.youtube.com/watch?v=_aHCQnpJWMo" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>
      </section>

      <div className="footer">
        <p>Learn Darius J. Wright's <a href="https://dariusjwright.com/my-mission" target="_blank" rel="noopener noreferrer" style={{color: '#00FFFF', textDecoration: 'none'}}>Mission</a></p>
      </div>
    </>
  );
};

export default OutOfBodyExperience;
