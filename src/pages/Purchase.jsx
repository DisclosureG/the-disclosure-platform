import { useEffect } from 'react';
import { Link } from 'react-router-dom';

const Purchase = () => {
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

    // Update crypto prices
    const updateCryptoPrices = async () => {
      const dollarAmount = 420.69;
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=dogecoin,pepe&vs_currencies=usd');
        const data = await response.json();
        const dogeRate = data.dogecoin.usd;
        const pepeRate = data.pepe.usd;
        
        const dogePrice = document.getElementById('dogePrice');
        const pepePrice = document.getElementById('pepePrice');
        
        if (dogePrice) dogePrice.textContent = (dollarAmount / dogeRate).toFixed(2);
        if (pepePrice) pepePrice.textContent = (dollarAmount / pepeRate).toFixed(0);
      } catch (error) {
        console.error("Error fetching crypto prices:", error);
        const dogePrice = document.getElementById('dogePrice');
        const pepePrice = document.getElementById('pepePrice');
        if (dogePrice) dogePrice.textContent = 'N/A';
        if (pepePrice) pepePrice.textContent = 'N/A';
      }
    };
    updateCryptoPrices();

    // Copy button functionality
    const setupCopyButton = (buttonId, addressId, tooltipId) => {
      const button = document.getElementById(buttonId);
      const address = document.getElementById(addressId);
      const tooltip = document.getElementById(tooltipId);

      if (button && address && tooltip) {
        button.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(address.textContent);
            tooltip.classList.add('show');
            setTimeout(() => tooltip.classList.remove('show'), 1500);
          } catch (err) {
            console.error('Copy failed:', err);
          }
        });
      }
    };

    setupCopyButton('copyDogeBtn', 'dogeAddress', 'copyTooltip');
    setupCopyButton('copyPepeBtn', 'pepeAddress', 'copyPepeTooltip');

    // Form submission
    const form = document.getElementById('paymentForm');
    const textarea = form?.querySelector('textarea');
    const buttons = form?.querySelectorAll('button[data-subject]');

    buttons?.forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        const subject = button.getAttribute('data-subject');
        const message = textarea?.value.trim() || '';
        const mailtoLink = `mailto:neo@interstellar-psychology.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
        window.location.href = mailtoLink;
      });
    });
  }, []);

  return (
    <>
      <div className="particles" id="particles"></div>

      <header className="header breathing-element">
        <h1>
          <div className="card-inner">A Multiverse of Love</div>
        </h1>
      </header>

      <section className="centered breathing-element" style={{paddingBottom: '9px'}}>
        <img 
          alt="A Multiverse of Love"
          className="glowing-image w-42"
          src="/artefacts/A-Multiverse-of-Love.png"
        />
      </section>

      <div className="payment-info">
        <div style={{textAlign: 'center'}}>
          <p style={{border: '2px solid rgb(99, 234, 234)', padding: '8px', display: 'inline-block', borderRadius: '6px'}}>
            <strong>Price:</strong> $420.69
          </p>
          <p>To purchase the book, please send the payment in Dogecoin OR Pepe to the address below:</p>
        </div>
        
        <div className="crypto-container">
          <div className="doge-card">
            <p><strong>Doge:</strong> ≈ <span id="dogePrice">Loading...</span> DOGE</p>
            <img alt="MyDoge QR" className="doge-qr" src="/artefacts/dogewallet.png" />
            <div className="doge-address-container">
              <p className="dogecoin-address" id="dogeAddress">DPr9yusdZ37758AEgFjUU6hfL5UiM2WYeT</p>
              <button aria-label="Copy Dogecoin address" className="tooltip-btn" id="copyDogeBtn">
                <svg fill="#000000" height="20" viewBox="0 0 24 24" width="20" xmlns="http://www.w3.org/2000/svg">
                  <path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 18H8V7h11v16Z"></path>
                </svg>
                <span className="tooltip-text" id="copyTooltip">Copied!</span>
              </button>
            </div>
          </div>

          <div className="pepe-card">
            <p><strong>Pepe:</strong> ≈ <span id="pepePrice">Loading...</span> PEPE</p>
            <img alt="Pepe Wallet QR" className="pepe-qr" src="/artefacts/pepewallet.png" />
            <div className="pepe-address-container">
              <p className="pepe-address" id="pepeAddress">0xed525bd95179D3600C84367521285864f5965A03</p>
              <button aria-label="Copy Pepe address" className="tooltip-btn" id="copyPepeBtn">
                <svg fill="#000000" height="20" viewBox="0 0 24 24" width="20" xmlns="http://www.w3.org/2000/svg">
                  <path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 18H8V7h11v16Z"></path>
                </svg>
                <span className="tooltip-text" id="copyPepeTooltip">Copied!</span>
              </button>
            </div>
          </div>
        </div>

        <div className="form-wrapper">
          <div className="form-container">
            <h2>Confirm Your Payment</h2>
            <p>
              After making your payment, please indicate whether you used 
              <strong> Doge</strong> or <strong>Pepe</strong>, and include your 
              <strong> transaction hash</strong> and <strong> delivery address</strong> below.
            </p>
            <form id="paymentForm">
              <textarea 
                name="message" 
                placeholder="Transaction Hash: XXXXXXXX&#10;Delivery Address: [Your Address]" 
                required
              ></textarea>
              <div className="button-row">
                <button className="doge-btn" data-subject="Doge" type="button">Doge</button>
                <button className="pepe-btn" data-subject="Pepe" type="button">Pepe</button>
              </div>
            </form>
            <p>(or mail to neo@interstellar-psychology.com)</p>
          </div>
        </div>
      </div>

       <div style={{textAlign: 'center', margin: '20px 0'}}>
        <Link to="/phd/multiverse">
          <button className="go-back-btn">Go Back</button>
        </Link>
      </div>

      <footer className="footer">
        <p>Interstellar Psychology <span className="heart">❤️</span></p>
      </footer>
    </>
  );
};

export default Purchase;
