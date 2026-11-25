import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { usesMock } from './engine/backend';
import { startEngine } from './engine/lifecycle';
import './styles/base.css';

// What frames in the app may load: the app itself and Compola's media scheme (cloud file previews). Add-on views are
// `srcdoc` documents (not fetched), and this is what stops one from navigating itself to an outside address with data
// in the URL (their own CSP cannot: a frame may always navigate itself). Added before anything renders.
{
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = `frame-src 'self' blob: data: compola-media: http://compola-media.localhost${usesMock ? ' https:' : ''}`;
  document.head.prepend(csp);
}

void startEngine();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
