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
      </section>

      <div className="footer">
        <p>Visit <a href="https://www.monroeinstitute.org/" target="_blank" rel="noopener noreferrer" style={{color: '#00FFFF', textDecoration: 'none'}}>Monroe Institute</a></p>
      </div>
    </>
  );
};

export default OutOfBodyExperience;
