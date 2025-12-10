import React from 'react';

const EasterEgg = () => {
  const [position, setPosition] = React.useState({ x: 100, y: 100 });
  const [velocity, setVelocity] = React.useState({ dx: 5, dy: 5 });
  const [imgSize, setImgSize] = React.useState(200);
  const requestRef = React.useRef();

  React.useEffect(() => {
    const handleResize = () => {
      setImgSize(window.innerWidth < 768 ? 100 : 200);
    };
    window.addEventListener('resize', handleResize);
    handleResize(); // Set initial size
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const animate = () => {
    setPosition(prevPos => {
      let newX = prevPos.x + velocity.dx;
      let newY = prevPos.y + velocity.dy;

      const currentImgSize = imgSize;

      let newDx = velocity.dx;
      let newDy = velocity.dy;

      // Check collisions
      if (newX <= 0 || newX + currentImgSize >= window.innerWidth) {
        newDx = -newDx;
        newX = Math.max(0, Math.min(newX, window.innerWidth - currentImgSize));
      }
      if (newY <= 0 || newY + currentImgSize >= window.innerHeight) {
        newDy = -newDy;
        newY = Math.max(0, Math.min(newY, window.innerHeight - currentImgSize));
      }

      if (newDx !== velocity.dx || newDy !== velocity.dy) {
        setVelocity({ dx: newDx, dy: newDy });
      }

      return { x: newX, y: newY };
    });
    requestRef.current = requestAnimationFrame(animate);
  };

  React.useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current);
  }, [velocity, imgSize]);

  return (
    <div style={{
      margin: 0,
      padding: 0,
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      position: 'fixed',
      top: 0,
      left: 0,
      backgroundColor: '#000'
    }}>
      <style>
        {`
          @keyframes trippyNeon {
            0% {
              box-shadow: 0 0 10px #fff, 0 0 20px #fff, 0 0 30px #e60073, 0 0 40px #e60073, 0 0 50px #e60073, 0 0 60px #e60073, 0 0 70px #e60073;
            }
            25% {
              box-shadow: 0 0 10px #fff, 0 0 20px #fff, 0 0 30px #ff00de, 0 0 40px #ff00de, 0 0 50px #ff00de, 0 0 60px #ff00de, 0 0 70px #ff00de;
            }
            50% {
              box-shadow: 0 0 10px #fff, 0 0 20px #fff, 0 0 30px #00ffff, 0 0 40px #00ffff, 0 0 50px #00ffff, 0 0 60px #00ffff, 0 0 70px #00ffff;
            }
            75% {
              box-shadow: 0 0 10px #fff, 0 0 20px #fff, 0 0 30px #00ff00, 0 0 40px #00ff00, 0 0 50px #00ff00, 0 0 60px #00ff00, 0 0 70px #00ff00;
            }
            100% {
              box-shadow: 0 0 10px #fff, 0 0 20px #fff, 0 0 30px #e60073, 0 0 40px #e60073, 0 0 50px #e60073, 0 0 60px #e60073, 0 0 70px #e60073;
            }
          }
        `}
      </style>
      <img
        src="/artefacts/dollarbill.jpg"
        alt="Dollar Bill Background"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 0
        }}
      />
      <img
        src="/artefacts/smile.jpeg"
        alt="Bouncing Smile"
        style={{
          width: `${imgSize}px`,
          height: `${imgSize}px`,
          objectFit: 'cover',
          position: 'absolute',
          left: position.x,
          top: position.y,
          zIndex: 1,
          animation: 'trippyNeon 2s infinite alternate',
          borderRadius: '50%' // Optional: make it round if desired, or keep square
        }}
      />
    </div>
  );
};

export default EasterEgg;
