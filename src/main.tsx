import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { startEngine } from './engine/lifecycle';
import './styles/base.css';

void startEngine();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
