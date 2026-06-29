import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Package, Trash2, RefreshCw, Clock, Eye, EyeOff,
  Users, Shield, Type, Image, Mic, FileUp, Loader2, AlertTriangle, Plus, Lock
} from 'lucide-react';
import { getCreatorId } from '../utils/creator';
import { getMyDropsAPI, deleteDropAPI } from '../utils/drops';
import { formatTimeRemaining } from '../utils/eph-file';

// ─── Component ────────────────────────────────────────────

const MyDrops = () => {
  const { t } = useTranslation();
  const [drops, setDrops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const navigate = useNavigate();

  const stegoDropIds = useMemo(() => {
    try { return new Set(JSON.parse(localStorage.getItem('stegoDropIds') || '[]')); }
    catch { return new Set(); }
  }, []);

  // ─── Fetch ──────────────────────────────────────────────

  const fetchDrops = useCallback(async () => {
    try {
      setLoading(true);
      const creatorId = getCreatorId();
      const data = await getMyDropsAPI(creatorId);
      setDrops(data.drops || []);
      setError(null);
    } catch (err) {
      console.error('Error fetching drops:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDrops();
  }, [fetchDrops]);

  // ─── Delete ─────────────────────────────────────────────

  const handleDelete = async (dropId) => {
    if (deletingId) return;
    setDeletingId(dropId);

    try {
      const creatorId = getCreatorId();
      await deleteDropAPI(dropId, creatorId);
      setDrops(prev => prev.filter(d => d.id !== dropId));
    } catch (err) {
      console.error('Error deleting drop:', err);
      alert('Failed to delete drop: ' + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  // ─── Helpers ────────────────────────────────────────────

  const getTypeIcon = (type) => {
    switch (type) {
      case 'image': return Image;
      case 'audio': return Mic;
      case 'file': return FileUp;
      default: return Type;
    }
  };

  const getStatusStyle = (drop) => {
    const now = Date.now();
    if (drop.expiresAt <= now) {
      return { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-600 dark:text-red-400', label: t('myDrops.status.expired') };
    }
    if (drop.claimedCount >= drop.recipientCount) {
      return { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-600 dark:text-green-400', label: t('myDrops.status.fullyClaimed') };
    }
    if (drop.claimedCount > 0) {
      return { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-600 dark:text-blue-400', label: t('myDrops.status.partiallyClaimed') };
    }
    return { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-600 dark:text-amber-400', label: t('myDrops.status.waiting') };
  };

  // ─── Render ─────────────────────────────────────────────

  return (
    <div style={{ height: '100vh', overflowY: 'auto' }} className="dark:bg-gray-900 transition-colors duration-200 no-scrollbar">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 shadow-sm transition-colors duration-200 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 pt-10 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2">
              <Package className="w-5 h-5 text-purple-500" />
              <h1 className="text-lg font-bold text-gray-900 dark:text-white">{t('myDrops.title')}</h1>
            </div>
          </div>
          <button
            onClick={fetchDrops}
            disabled={loading}
            className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-3xl mx-auto px-4 py-6">
        {/* Loading */}
        {loading && drops.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 space-y-3">
            <Loader2 className="w-8 h-8 text-purple-500 animate-spin" />
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('myDrops.loading')}</p>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800/50 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-700 dark:text-red-400">{t('myDrops.failed')}</p>
              <p className="text-xs text-red-600 dark:text-red-400 mt-1">{error}</p>
              <button
                onClick={fetchDrops}
                className="mt-2 text-xs font-medium text-red-600 dark:text-red-400 hover:text-red-700 underline"
              >
                {t('common.retry')}
              </button>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && drops.length === 0 && (
          <div className="text-center py-16 space-y-4">
            <div className="w-20 h-20 mx-auto bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center">
              <Package className="w-10 h-10 text-gray-400" />
            </div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">{t('myDrops.noDrops')}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto">
              {t('myDrops.noDropsHint')}
            </p>
            <button
              onClick={() => navigate('/?action=create-drop')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white font-bold rounded-xl transition-colors text-sm"
            >
              <Plus className="w-4 h-4" />
              {t('myDrops.createFirst')}
            </button>
          </div>
        )}

        {/* Drop Cards */}
        {drops.length > 0 && (
          <div className="space-y-3">
            {drops.map(drop => {
              const status = getStatusStyle(drop);
              const TypeIcon = getTypeIcon(drop.contentType);
              const isExpired = drop.expiresAt <= Date.now();

              return (
                <div
                  key={drop.id}
                  className={`bg-white dark:bg-gray-800 rounded-xl border transition-colors ${
                    isExpired
                      ? 'border-gray-200 dark:border-gray-700 opacity-60'
                      : 'border-gray-200 dark:border-gray-700'
                  }`}
                >
                  <div className="p-4">
                    {/* Top Row */}
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-purple-100 dark:bg-purple-900/30 rounded-lg">
                          <TypeIcon className="w-4 h-4 text-purple-500" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-[200px]">
                            {drop.hint || `${(drop.contentType || 'text')} drop`}
                          </p>
                          <p className="text-xs text-gray-400 dark:text-gray-500 font-mono">
                            {drop.id?.substring(0, 16)}...
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {stegoDropIds.has(drop.id) && (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400" title={t('myDrops.stegoLabel')}>
                            <Lock className="w-2.5 h-2.5" />
                            {t('myDrops.stegoLabel')}
                          </span>
                        )}
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
                          {status.label}
                        </span>
                        <button
                          onClick={() => handleDelete(drop.id)}
                          disabled={deletingId === drop.id}
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                          title="Delete drop"
                        >
                          {deletingId === drop.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Stats Row */}
                    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {drop.claimedCount || 0}/{drop.recipientCount} {t('myDrops.claimed')}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {isExpired ? t('myDrops.status.expired') : formatTimeRemaining(drop.expiresAt)}
                      </span>
                      {drop.viewOnce && (
                        <span className="flex items-center gap-1">
                          <EyeOff className="w-3 h-3" />
                          {t('myDrops.viewOnce')}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Shield className="w-3 h-3" />
                        {t('myDrops.encrypted')}
                      </span>
                    </div>

                    {/* Verbal Code */}
                    {drop.verbalCode && !isExpired && (
                      <div className="mt-2 px-2 py-1 bg-purple-50 dark:bg-purple-900/10 rounded text-xs font-mono text-purple-600 dark:text-purple-400 inline-block">
                        {drop.verbalCode}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default MyDrops;
