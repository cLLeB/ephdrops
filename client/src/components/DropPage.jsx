import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, Package, AlertTriangle, ArrowLeft } from 'lucide-react';
import ClaimDropModal from './ClaimDropModal';
import DropViewer from './DropViewer';

/**
 * Route handler for /drop/:dropId
 * Shows drop info and prompts to claim
 */
const DropPage = () => {
  const { dropId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [phase, setPhase] = useState('loading'); // 'loading' | 'claim' | 'view' | 'error'
  const [claimData, setClaimData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dropId) {
      setPhase('error');
      setError(t('dropx.err.noDropId'));
      return;
    }

    // Go straight to claim phase — ClaimDropModal will verify drop existence
    setPhase('claim');
  }, [dropId]);

  const handleDropClaimed = (data) => {
    setClaimData(data);
    setPhase('view');
  };

  const handleClose = () => {
    navigate('/');
  };

  // Loading
  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center dark:bg-gray-900">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 text-purple-500 animate-spin mx-auto" />
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('drops.page.lookingUp')}</p>
        </div>
      </div>
    );
  }

  // Error
  if (phase === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center dark:bg-gray-900 p-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 mx-auto bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
            <AlertTriangle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">{t('drops.page.notFound')}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white font-medium rounded-lg transition-colors text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('common.goHome')}
          </button>
        </div>
      </div>
    );
  }

  // Claim modal
  if (phase === 'claim') {
    return (
      <ClaimDropModal
        onClose={handleClose}
        onDropClaimed={handleDropClaimed}
        initialDropId={dropId}
      />
    );
  }

  // View decrypted content
  if (phase === 'view' && claimData) {
    return (
      <DropViewer
        onClose={handleClose}
        claimData={claimData}
      />
    );
  }

  return null;
};

export default DropPage;
