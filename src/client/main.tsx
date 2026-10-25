import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import './mobile.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root 缺失');

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
