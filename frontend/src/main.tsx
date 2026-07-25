import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { GuildProvider } from './auth/GuildContext';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AuthProvider>
        <GuildProvider>
          <App />
        </GuildProvider>
      </AuthProvider>
    </HashRouter>
  </React.StrictMode>,
);
