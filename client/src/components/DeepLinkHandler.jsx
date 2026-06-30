import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isCapacitor } from '../utils/platform';

/**
 * Handles Android App Links inside the Capacitor shell.
 *
 * When the OS opens the app via a https://beternow-ephdrops.hf.space/drop/<id>
 * link, Capacitor fires `appUrlOpen` with the full URL. We translate that into
 * an in-app route so the drop opens directly instead of dropping the user on
 * the home screen. No-op on web/desktop (the browser/router handle URLs there).
 */
export default function DeepLinkHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isCapacitor) return;

    let cleanup = () => {};
    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const handle = await App.addListener('appUrlOpen', ({ url }) => {
          try {
            const parsed = new URL(url);
            const route = parsed.pathname + parsed.search + parsed.hash;
            if (route && route !== '/') navigate(route);
          } catch {
            /* ignore malformed deep links */
          }
        });
        cleanup = () => handle.remove();
      } catch {
        /* @capacitor/app unavailable — nothing to wire up */
      }
    })();

    return () => cleanup();
  }, [navigate]);

  return null;
}
