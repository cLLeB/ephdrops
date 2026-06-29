import React, { useState } from 'react';
import { X, Mail, Link as LinkIcon, Check, Copy } from 'lucide-react';
import { CopyToClipboard } from 'react-copy-to-clipboard';
import { hapticSuccess, isTauri } from '../utils/platform';

/**
 * Open a URL safely across all environments:
 *  - Tauri desktop: use the native shell opener (window.electronAPI.openUrlExternal)
 *    because window.open() is silently swallowed by Tauri's WebView.
 *  - Everything else: fall back to window.open().
 */
function openUrl(url) {
  if (window.electronAPI?.openUrlExternal) {
    window.electronAPI.openUrlExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// Simple icons for social platforms (Lucide doesn't have brand icons like WhatsApp/Telegram natively)
// We'll use SVGs or text for them.
const WhatsAppIcon = () => (
    <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6"><path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21" /><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0 .5-.5l1-1h4l1 1a.5.5 0 0 0 .5.5v1a.5.5 0 0 0 1 0V9a1.5 1.5 0 0 0-1.5-1.5h-4.998A1.5 1.5 0 0 0 9 9v1z" fill="none" stroke="none" /><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
);

const TelegramIcon = () => (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
        <path d="M20.665 3.717l-17.73 6.837c-1.21.486-1.203 1.161-.222 1.462l4.552 1.42 10.532-6.645c.498-.303.953-.14.579.192l-8.533 7.701v3.13c.307 0 .443-.14.615-.307l1.475-1.432 3.07 2.268c.565.312.973.152 1.115-.522l2.015-9.492c.206-.822-.315-1.192-1.258-.762z" />
    </svg>
);


const ShareSheet = ({ isOpen, onClose, shareData }) => {
    const [isCopied, setIsCopied] = useState(false);

    if (!isOpen) return null;

    const { url, text, title } = shareData;
    const encodedUrl = encodeURIComponent(url);
    const encodedText = encodeURIComponent(text);

    const handleCopy = () => {
        setIsCopied(true);
        hapticSuccess();
        setTimeout(() => {
            setIsCopied(false);
            onClose(); // Optional: close after copy? Maybe keep open.
        }, 1000);
    };

    // On Tauri desktop, use native URI schemes so the installed desktop app opens
    // directly via OS protocol handlers. On web/Electron, use the standard share URLs.
    const shareOptions = [
        {
            name: 'WhatsApp',
            icon: <WhatsAppIcon />,
            color: 'bg-green-500 hover:bg-green-600',
            action: () => {
                const waUrl = window.electronAPI?.isTauri
                    ? `whatsapp://send?text=${encodedText}%20${encodedUrl}`
                    : `https://wa.me/?text=${encodedText}%20${encodedUrl}`;
                openUrl(waUrl);
                onClose();
            }
        },
        {
            name: 'Telegram',
            icon: <TelegramIcon />,
            color: 'bg-blue-500 hover:bg-blue-600',
            action: () => {
                const tgUrl = window.electronAPI?.isTauri
                    ? `tg://msg_url?url=${encodedUrl}&text=${encodedText}`
                    : `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`;
                openUrl(tgUrl);
                onClose();
            }
        },
        {
            name: 'Email',
            icon: <Mail className="w-6 h-6" />,
            color: 'bg-gray-500 hover:bg-gray-600',
            action: () => {
                openUrl(`mailto:?subject=${encodeURIComponent(title)}&body=${encodedText}%0A%0A${encodedUrl}`);
                onClose();
            }
        }
    ];

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-end sm:items-center justify-center p-4 z-[60]">
            <div className="bg-white dark:bg-gray-800 rounded-t-xl sm:rounded-xl p-6 w-full max-w-sm animate-in slide-in-from-bottom duration-200">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                        Share via
                    </h3>
                    <button
                        onClick={onClose}
                        className="p-1 text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="grid grid-cols-4 gap-4 mb-6">
                    {shareOptions.map((option) => (
                        <button
                            key={option.name}
                            onClick={option.action}
                            className="flex flex-col items-center gap-2 group"
                        >
                            <div className={`w-12 h-12 flex items-center justify-center rounded-full text-white shadow-sm transition-transform group-hover:scale-105 ${option.color}`}>
                                {option.icon}
                            </div>
                            <span className="text-xs text-gray-600 dark:text-gray-400 font-medium">{option.name}</span>
                        </button>
                    ))}

                    <CopyToClipboard text={url} onCopy={handleCopy}>
                        <button className="flex flex-col items-center gap-2 group">
                            <div className={`w-12 h-12 flex items-center justify-center rounded-full text-white shadow-sm transition-transform group-hover:scale-105 ${isCopied ? 'bg-green-500' : 'bg-gray-700 dark:bg-gray-600'}`}>
                                {isCopied ? <Check className="w-6 h-6" /> : <Copy className="w-6 h-6" />}
                            </div>
                            <span className="text-xs text-gray-600 dark:text-gray-400 font-medium">
                                {isCopied ? 'Copied' : 'Copy'}
                            </span>
                        </button>
                    </CopyToClipboard>
                </div>

                <div className="pt-4 border-t border-gray-100 dark:border-gray-700">
                    <div className="p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg flex items-center justify-between group cursor-pointer" onClick={() => {
                        // Select text on click logic defined in parent usually, effectively just show link
                    }}>
                        <div className="flex items-center gap-3 overflow-hidden">
                            <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-full text-blue-600 dark:text-blue-400">
                                <LinkIcon className="w-4 h-4" />
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className="text-xs text-gray-500 dark:text-gray-400 truncate">Invite Link</span>
                                <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{url}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ShareSheet;
