import { useEffect } from 'react';

const Mindsight = () => {
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
          <div className="card-inner">Mindsight</div>
        </h1>
      </header>

      <section className="intro breathing-element" style={{ "--delay": "0.5s" }}>
        <p>At 11 years old, Happy is activating dormant abilities that go far beyond ordinary vision. What he demonstrates here is not imagination or guesswork—it's real perception beyond the physical eyes. By tapping into his soul awareness and expanding his consciousness, Happy is able to see what others can't, showing us the potential that lives within all of us when the inner senses are awakened. This is more than a skill. It's a reminder of who we truly are & the abilities we have with practice.</p>
      </section>

      <section className="explore-intro breathing-element" style={{ "--delay": "1s" }}>
        <p>Open your mind and explore the trippy realm of Mindsight through these mind-bending videos.</p>
        <p>Dive deep into the cosmic rabbit hole and awaken your third eye!</p>
      </section>

      <section className="video-grid">
        <div className="video-card breathing-element" style={{ '--delay': '1.5s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=oByMP-5VDNg" target="_blank" rel="noopener noreferrer">
              <img src="https://cdn.pixabay.com/photo/2023/01/19/10/35/eye-7728794_1280.jpg" alt="Happy's mindsight demonstration" />
            </a>
            <h3>Happy's mindsight demonstration</h3>
            <a href="https://www.youtube.com/watch?v=oByMP-5VDNg" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{ '--delay': '2.0s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=wcTXv1bTGU8" target="_blank" rel="noopener noreferrer">
              <img src="https://t4.ftcdn.net/jpg/05/75/96/25/360_F_575962574_g0G1Hq04wLbZTMeUf1HsmgWJRrmDcJXD.jpg" alt="Mindsight padawans" />
            </a>
            <h3>Mindsight padawans</h3>
            <a href="https://www.youtube.com/watch?v=wcTXv1bTGU8" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{ '--delay': '2.5s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=zuL-3ovm1-o" target="_blank" rel="noopener noreferrer">
              <img src="https://t4.ftcdn.net/jpg/05/75/96/27/360_F_575962701_aOHMTeeiAlW1C2bnKOtvXs36AFnP9GLF.jpg" alt="Mindsight in Germany" />
            </a>
            <h3>Mindsight in Germany</h3>
            <a href="https://www.youtube.com/watch?v=zuL-3ovm1-o" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>
      </section>

      <section className="video-grid">
        <div className="video-card breathing-element" style={{ '--delay': '3.0s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=cS0EzNVDTqI&t=2s" target="_blank" rel="noopener noreferrer">
              <img src="https://t3.ftcdn.net/jpg/06/07/10/54/360_F_607105479_VBzittvDxhvPCWQp6ly4qolzDXVZHxCh.jpg" alt="Mindsight demonstration" />
            </a>
            <h3>Mindsight with kids</h3>
            <a href="https://www.youtube.com/watch?v=cS0EzNVDTqI&t=2s" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{ '--delay': '3.5s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=rC7xZmLcOeY&t=10s" target="_blank" rel="noopener noreferrer">
              <img src="https://t3.ftcdn.net/jpg/09/17/33/56/360_F_917335601_AFw3wHSX7sF05inRVRsF4i8Y0cXSF5wz.jpg" alt="Mindsight demonstrations" />
            </a>
            <h3>Mindsight with kids</h3>
            <a href="https://www.youtube.com/watch?v=rC7xZmLcOeY&t=10s" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{ '--delay': '4.0s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=YoHB3dMpPhs&t=1s" target="_blank" rel="noopener noreferrer">
              <img src="https://t3.ftcdn.net/jpg/05/68/57/66/360_F_568576697_b3vPF55yt7M09mAdjfwpX5YgbfFVafbv.jpg" alt="Mindsight demonstration" />
            </a>
            <h3>Mindsight demonstration</h3>
            <a href="https://www.youtube.com/watch?v=YoHB3dMpPhs&t=1s" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>
      </section>

      <section className="video-grid">
        <div className="video-card breathing-element" style={{ '--delay': '4.5s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=RCqmendohP8" target="_blank" rel="noopener noreferrer">
              <img src="https://img.freepik.com/premium-photo/painting-psychedelic-eye-with-flower-center-generative-ai_958078-32386.jpg?semt=ais_incoming&w=740&q=80" alt="Dalia Burgoin mindsight demonstration" />
            </a>
            <h3>Dalia Burgoin mindsight demonstration</h3>
            <a href="https://www.youtube.com/watch?v=RCqmendohP8" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{ '--delay': '5.0s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=g-ckmDlZvTk" target="_blank" rel="noopener noreferrer">
              <img src="https://t4.ftcdn.net/jpg/13/00/29/75/360_F_1300297587_5GdmCwQdmlnr2hGdPGo5RLyo2vWaylJh.jpg" alt="Contact in the Dessert Mindsight Demonstration" />
            </a>
            <h3>Contact in the Dessert Mindsight Demonstration</h3>
            <a href="https://www.youtube.com/watch?v=g-ckmDlZvTk" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>

        <div className="video-card breathing-element" style={{ '--delay': '5.5s' }}>
          <div className="card-inner">
            <a href="https://www.youtube.com/watch?v=uZXF1WMy_PA&t=3s" target="_blank" rel="noopener noreferrer">
              <img src="https://t4.ftcdn.net/jpg/13/97/02/41/360_F_1397024144_M3fBFRY3Unpd2LhsgwJyrqI555fwbUec.jpg" alt="Dalia Bourgoin Mindsight" />
            </a>
            <h3>Mindsight Demonstration</h3>
            <a href="https://www.youtube.com/watch?v=uZXF1WMy_PA&t=3s" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
          </div>
        </div>
      </section>

      <div className="footer">
        <p>Begin <a href="https://share.google/K8bcbMDo6zG3OvdRQ" target="_blank" rel="noopener noreferrer" style={{ color: '#00FFFF', textDecoration: 'none' }}>now</a>, your potential is limitless!</p>
      </div>
    </>
  );
};

export default Mindsight;
