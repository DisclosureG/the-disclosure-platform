import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/interstellar.css';
import AuthorAdmin from './components/AuthorAdmin';

createRoot(document.getElementById('admin-root')).render(
  <StrictMode>
    <AuthorAdmin />
  </StrictMode>
);
