import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import DropsHome from './components/DropsHome';
import MyDrops from './components/MyDrops';
import DropPage from './components/DropPage';

/**
 * Standalone Ephemeral Drops app.
 *
 * Routes are trimmed to just the drops surface:
 *   /              → landing (create / claim / my-drops)
 *   /my-drops      → list of drops created on this device
 *   /drop/:dropId  → claim + view a specific drop
 */
function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<DropsHome />} />
        <Route path="/my-drops" element={<MyDrops />} />
        <Route path="/drop/:dropId" element={<DropPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastContainer position="bottom-center" theme="colored" />
    </Router>
  );
}

export default App;
