import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import AudioPlayer from './AudioPlayer';

const Layout = ({ children }) => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const location = useLocation();
  const sidebarRef = useRef(null);
  const wheelRef = useRef(null);

  const toggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen);
  };

  const closeSidebar = () => {
    setIsSidebarOpen(false);
  };

  // Prevent body scroll when sidebar is open (mobile only)
  useEffect(() => {
    const isMobile = window.innerWidth <= 768;
    
    if (isSidebarOpen && isMobile) {
      const scrollY = window.scrollY;
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = '100%';
    } else {
      const scrollY = document.body.style.top;
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      if (scrollY) {
        window.scrollTo(0, parseInt(scrollY || '0') * -1);
      }
    }
    
    return () => {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
    };
  }, [isSidebarOpen]);

  const isActive = (path) => {
    return location.pathname === path;
  };

  // Buttery smooth infinite wheel scrolling
  useEffect(() => {
    if (!isSidebarOpen || !wheelRef.current) return;

    const wheel = wheelRef.current;
    const items = Array.from(wheel.querySelectorAll('a'));
    const itemCount = items.length;
    
    // Find active page and snap to it initially
    const activeIndex = items.findIndex(item => {
      const href = item.getAttribute('href');
      return href === location.pathname;
    });
    
    const itemSpacing = 100; // Distance between items in pixels
    const initialRotation = activeIndex >= 0 ? activeIndex * itemSpacing : 0;
    
    let currentRotation = initialRotation;
    let targetRotation = initialRotation;
    let velocity = 0;
    let lastY = 0;
    let lastTime = 0;
    let isDragging = false;
    let animationFrame = null;

    const updateWheel = () => {
      // Apply momentum/friction - balanced wheel spin
      if (!isDragging) {
        velocity *= 0.92; // Moderate friction for controlled spin
        currentRotation += velocity;
        
        // Only snap when velocity is very low
        if (Math.abs(velocity) < 0.5) {
          const snapTarget = Math.round(currentRotation / itemSpacing) * itemSpacing;
          const diff = snapTarget - currentRotation;
          currentRotation += diff * 0.1; // Gentle snap
          velocity *= 0.85; // Dampen velocity during snap
        }
      }

      // Update each item's position
      items.forEach((item, index) => {
        const offset = index - (currentRotation / itemSpacing);
        const normalizedOffset = ((offset % itemCount) + itemCount) % itemCount;
        const adjustedOffset = normalizedOffset > itemCount / 2 
          ? normalizedOffset - itemCount 
          : normalizedOffset;

        const translateY = adjustedOffset * itemSpacing;
        const distance = Math.abs(adjustedOffset);
        
        // Smooth scaling based on distance from center, no blur
        const scale = Math.max(0.7, 1.2 - distance * 0.25);
        
        item.style.transform = `translate(0, calc(-50% + ${translateY}px)) scale(${scale})`;
        item.style.opacity = 1;
        item.style.filter = 'none';
        item.style.zIndex = Math.round(100 - distance * 10);
      });

      // Continue animation
      animationFrame = requestAnimationFrame(updateWheel);
    };

    const handleTouchStart = (e) => {
      isDragging = true;
      lastY = e.touches[0].clientY;
      lastTime = Date.now();
      velocity = 0;
      targetRotation = currentRotation;
    };

    const handleTouchMove = (e) => {
      if (!isDragging) return;
      
      e.preventDefault(); // Prevent page scroll
      e.stopPropagation(); // Stop event bubbling
      
      const currentY = e.touches[0].clientY;
      const currentTime = Date.now();
      const deltaY = currentY - lastY;
      const deltaTime = Math.max(1, currentTime - lastTime);
      
      // Calculate velocity for momentum - negative to match rotation direction
      velocity = -(deltaY / deltaTime) * 18; // Negative to match currentRotation direction
      
      // Direct manipulation while dragging
      currentRotation -= deltaY * 1.2;
      
      lastY = currentY;
      lastTime = currentTime;
    };

    const handleTouchEnd = () => {
      isDragging = false;
      // Let momentum carry it, no immediate snap
      // Wheel will naturally slow down and snap when velocity < 0.5
    };

    const handleWheel = (e) => {
      e.preventDefault();
      velocity += e.deltaY * 0.1; // Reduced for less loose spin
      // No immediate snap, let it spin freely
    };

    // Start animation loop
    updateWheel();

    wheel.addEventListener('touchstart', handleTouchStart, { passive: true });
    wheel.addEventListener('touchmove', handleTouchMove, { passive: false });
    wheel.addEventListener('touchend', handleTouchEnd, { passive: true });
    wheel.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      cancelAnimationFrame(animationFrame);
      wheel.removeEventListener('touchstart', handleTouchStart);
      wheel.removeEventListener('touchmove', handleTouchMove);
      wheel.removeEventListener('touchend', handleTouchEnd);
      wheel.removeEventListener('wheel', handleWheel);
    };
  }, [isSidebarOpen, location.pathname]);

  return (
    <>
      <AudioPlayer />
      
      <button 
        className="menu-toggle" 
        aria-label="Open navigation menu"
        onClick={toggleSidebar}
      >
        ☰
      </button>

      <div 
        className={`sidebar-overlay ${isSidebarOpen ? 'show' : ''}`}
        onClick={closeSidebar}
      />

      <nav ref={sidebarRef} className={`sidebar-nav ${isSidebarOpen ? 'open' : ''}`}>
        <div ref={wheelRef} className="wheel-container">
        <Link to="/" onClick={closeSidebar}>Interstellar Psychology</Link>
        <Link 
          to="/phd/music" 
          className={isActive('/phd/music') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Music
        </Link>
        <Link 
          to="/phd/psychedelics" 
          className={isActive('/phd/psychedelics') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Psychedelics
        </Link>
        <Link 
          to="/phd/telepathy" 
          className={isActive('/phd/telepathy') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Telepathy
        </Link>
        <Link 
          to="/phd/mindsight" 
          className={isActive('/phd/mindsight') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Mindsight
        </Link>
        <Link 
          to="/phd/remote-viewing" 
          className={isActive('/phd/remote-viewing') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Remote Viewing
        </Link>
        <Link 
          to="/phd/out-of-body-experience" 
          className={isActive('/phd/out-of-body-experience') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Out of Body Experience
        </Link>
        <Link 
          to="/phd/non-human-intelligence" 
          className={isActive('/phd/non-human-intelligence') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Non Human Intelligence
        </Link>
        <Link 
          to="/phd/multiverse" 
          className={isActive('/phd/multiverse') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Multiverse
        </Link>
        <Link 
          to="/phd/infinity" 
          className={isActive('/phd/infinity') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Infinity
        </Link>
        <Link 
          to="/phd/easter-egg" 
          className={isActive('/phd/easter-egg') ? 'active' : ''}
          onClick={closeSidebar}
        >
          🥚 Easter Egg
        </Link>
        <Link 
          to="/phd" 
          className={isActive('/phd') ? 'active' : ''}
          onClick={closeSidebar}
        >
          PhD
        </Link>
        <Link 
          to="/phd/multiverse/purchase" 
          className={isActive('/phd/multiverse/purchase') ? 'active' : ''}
          onClick={closeSidebar}
        >
          Purchase
        </Link>
        </div>
      </nav>

      {children}
    </>
  );
};

export default Layout;
