import React, { useState } from 'react';
import { Download, MonitorSmartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuideModal, setShowGuideModal] = useState(false);

  const handleClick = async () => {
    if (isInstallable) {
      await install();
      return;
    }
    setShowGuideModal(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 whitespace-nowrap shrink-0 cursor-pointer"
      >
        {isInstalled ? (
          <>
            <MonitorSmartphone className="h-4 w-4 shrink-0" />
            <span>App Ready</span>
          </>
        ) : (
          <>
            <Download className="h-4 w-4 shrink-0" />
            <span>Install App</span>
          </>
        )}
      </button>

      {showGuideModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="install-modal-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-[#111622] p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 id="install-modal-title" className="text-lg font-bold text-slate-100">
                  {isInstalled ? 'ClearReel App Installed' : 'Install ClearReel App'}
                </h3>
                <p className="mt-1 text-sm text-slate-400">
                  Run ClearReel as a standalone desktop or mobile app with offline studio controls.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                aria-label="Close install instructions"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {isInstalled ? (
              <p className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                You are running ClearReel in standalone app mode. Upload local videos or paste direct links anytime.
              </p>
            ) : isIOS ? (
              <ol className="mt-4 space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                <li>1. Tap the <strong className="text-white">Share</strong> icon in your Safari toolbar.</li>
                <li>2. Scroll down and select <strong className="text-white">Add to Home Screen</strong>.</li>
                <li>3. Tap <strong className="text-white">Add</strong> to launch ClearReel like a native iOS app.</li>
              </ol>
            ) : (
              <ol className="mt-4 space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                <li>1. Open this site in Chrome, Edge, or Android Chrome outside preview frames.</li>
                <li>2. Click the <strong className="text-white">Install ClearReel</strong> icon in the address bar or browser menu.</li>
                <li>3. Launch directly from your desktop dock or phone home screen.</li>
              </ol>
            )}

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700 cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-950/90 px-3.5 py-2 text-xs font-medium text-amber-200 shadow-lg">
      <WifiOff className="h-3.5 w-3.5 text-amber-400" />
      <span>Offline Mode — Cached interface active</span>
    </div>
  );
};
