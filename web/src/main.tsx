import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyScale, currentScale } from './api';
import './tokens.css';
import './app.css';
import { App } from './App';

// Before first paint, so a reader who chose larger type never sees it resize under them.
applyScale(currentScale());

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
