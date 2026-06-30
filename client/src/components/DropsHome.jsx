import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Package, Plus, KeyRound, FolderClock, Shield, Clock, EyeOff, Settings } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import CreateDropModal from './CreateDropModal';
import DropCreatedModal from './DropCreatedModal';
import ClaimDropModal from './ClaimDropModal';
import DropViewer from './DropViewer';
import SettingsModal from './SettingsModal';

/**
 * Standalone landing page for Ephemeral Drops.
 *
 * Hosts the three entry points that, in the full chat app, were reachable from
 * the chat surface: create a drop, claim a drop (by ID / verbal code / .eph
 * file), and view your own drops. The create/claim/view components themselves
 * are copied verbatim from the source project — this is only the host shell.
 */
const DropsHome = () => {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const navigate = useNavigate();

  const [showCreate, setShowCreate] = useState(false);
  const [showClaim, setShowClaim] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [createdDrop, setCreatedDrop] = useState(null);
  const [claimData, setClaimData] = useState(null);

  const handleDropCreated = (dropData) => {
    setShowCreate(false);
    setCreatedDrop(dropData);
  };

  const handleDropClaimed = (data) => {
    setShowClaim(false);
    setClaimData(data);
  };

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-950 dark:to-gray-900 flex flex-col items-center px-4 py-10">
      {/* Settings */}
      <button
        onClick={() => setShowSettings(true)}
        aria-label={t('settings.title', 'Settings')}
        className="absolute top-4 right-4 p-2.5 rounded-full text-gray-500 dark:text-gray-400 bg-white/70 dark:bg-gray-800/70 backdrop-blur hover:bg-white dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 transition-colors"
      >
        <Settings className="w-5 h-5" />
      </button>

      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto bg-purple-100 dark:bg-purple-900/30 rounded-2xl flex items-center justify-center">
            <Package className="w-9 h-9 text-purple-500" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {t('dropx.home.title', 'Ephemeral Drops')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('dropx.home.tagline', 'Encrypted, self-destructing drops. The server never sees your content.')}
          </p>
        </div>

        {/* Primary actions */}
        <div className="space-y-3">
          <button
            onClick={() => setShowCreate(true)}
            className="w-full flex items-center gap-3 px-5 py-4 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-xl transition-colors shadow-sm"
          >
            <Plus className="w-5 h-5" />
            {t('dropx.home.createDrop', 'Create a Drop')}
          </button>

          <button
            onClick={() => setShowClaim(true)}
            className="w-full flex items-center gap-3 px-5 py-4 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-white font-semibold rounded-xl border border-gray-200 dark:border-gray-700 transition-colors"
          >
            <KeyRound className="w-5 h-5 text-purple-500" />
            {t('dropx.home.claimDrop', 'Claim a Drop')}
          </button>

          <button
            onClick={() => navigate('/my-drops')}
            className="w-full flex items-center gap-3 px-5 py-4 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-white font-semibold rounded-xl border border-gray-200 dark:border-gray-700 transition-colors"
          >
            <FolderClock className="w-5 h-5 text-purple-500" />
            {t('dropx.home.myDrops', 'My Drops')}
          </button>
        </div>

        {/* Trust badges */}
        <div className="grid grid-cols-3 gap-3 pt-2">
          <div className="text-center space-y-1.5">
            <Shield className="w-5 h-5 text-purple-500 mx-auto" />
            <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('dropx.home.badge.e2ee', 'End-to-end encrypted')}</p>
          </div>
          <div className="text-center space-y-1.5">
            <Clock className="w-5 h-5 text-purple-500 mx-auto" />
            <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('dropx.home.badge.ttl', 'Auto-expiring')}</p>
          </div>
          <div className="text-center space-y-1.5">
            <EyeOff className="w-5 h-5 text-purple-500 mx-auto" />
            <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('dropx.home.badge.viewOnce', 'View-once option')}</p>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateDropModal
          onClose={() => setShowCreate(false)}
          onDropCreated={handleDropCreated}
        />
      )}

      {createdDrop && (
        <DropCreatedModal
          onClose={() => setCreatedDrop(null)}
          dropData={createdDrop}
        />
      )}

      {showClaim && (
        <ClaimDropModal
          onClose={() => setShowClaim(false)}
          onDropClaimed={handleDropClaimed}
        />
      )}

      {claimData && (
        <DropViewer
          onClose={() => setClaimData(null)}
          claimData={claimData}
        />
      )}

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
};

export default DropsHome;
