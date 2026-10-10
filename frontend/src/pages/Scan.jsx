import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Html5Qrcode } from 'html5-qrcode';
import { parseQrText } from '../api.js';
import { useInstitution } from '../components/Layouts.jsx';
import { FileDrop } from '../components/ui.jsx';

export default function Scan() {
  const navigate = useNavigate();
  const info = useInstitution();
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState('');
  const [foreign, setForeign] = useState(null);
  const scannerRef = useRef(null);
  const handledRef = useRef(false);

  const trustedOrigins = [window.location.origin];
  if (info?.portalUrl) {
    try {
      trustedOrigins.push(new URL(info.portalUrl).origin);
    } catch {
      /* ignore malformed config */
    }
  }

  const handleText = (text) => {
    const parsed = parseQrText(text, trustedOrigins);
    if (parsed.id) navigate(`/verify/${encodeURIComponent(parsed.id)}${parsed.search ?? ''}`);
    else if (parsed.foreignUrl) setForeign(parsed);
    else setMessage("That QR code doesn't contain a certificate link.");
  };

  const stop = useCallback(async () => {
    const s = scannerRef.current;
    scannerRef.current = null;
    if (s) {
      try {
        if (s.isScanning) await s.stop();
        s.clear();
      } catch {
        /* already stopped */
      }
    }
    setScanning(false);
  }, []);

  useEffect(() => () => void stop(), [stop]);

  async function start() {
    setMessage('');
    setForeign(null);
    handledRef.current = false;
    try {
      const scanner = new Html5Qrcode('qr-reader', { verbose: false });
      scannerRef.current = scanner;
      setScanning(true);
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (text) => {
          if (handledRef.current) return;
          handledRef.current = true;
          stop().then(() => handleText(text));
        },
        () => {},
      );
    } catch (e) {
      await stop();
      setMessage(
        `Camera unavailable (${e?.message || e}). Camera access needs HTTPS or localhost; you can upload a photo of the QR code instead.`,
      );
    }
  }

  async function scanImage(file) {
    setMessage('');
    setForeign(null);
    const reader = new Html5Qrcode('qr-file-reader', { verbose: false });
    try {
      handleText(await reader.scanFile(file, false));
    } catch {
      setMessage('No QR code could be read from that image. Try a sharper, well-lit photo.');
    } finally {
      try {
        reader.clear();
      } catch {
        /* nothing rendered */
      }
    }
  }

  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div>
        <div className="eyebrow">Employer scans QR</div>
        <h1>Scan the certificate's QR code</h1>
        <p className="lead">
          The QR code is on the verification page at the end of the certificate. It carries the certificate ID, the
          document hash and the institution's signature, which are cross-checked against the registry.
        </p>
        <div className="callout">
          <strong>The QR code is only a pointer, never proof on its own.</strong> If a code sends you to a different
          website, we'll warn you instead of following it.
        </div>
      </div>

      <div className="card stack">
        {/* Always in the layout: the library measures this element before React re-renders. */}
        <div id="qr-reader" />
        <div id="qr-file-reader" style={{ display: 'none' }} />
        {scanning ? (
          <button className="btn ghost block" onClick={stop}>
            Stop camera
          </button>
        ) : (
          <button className="btn primary block" onClick={start}>
            Start camera
          </button>
        )}
        <FileDrop
          onFile={scanImage}
          accept="image/*"
          title="Or upload a photo / screenshot of the QR"
          hint="PNG, JPG or HEIC from your phone"
        />
        {message && <div className="error-box">{message}</div>}
        {foreign && (
          <div className="card" style={{ borderColor: 'var(--bad)' }}>
            <div className="card-title" style={{ color: 'var(--bad)' }}>
              This QR code points to another website
            </div>
            <p className="hash">{foreign.foreignUrl}</p>
            <p className="small">
              A copied or fake QR code can lead to a look-alike page that always says “Verified”. We have not opened it.
            </p>
            {foreign.embeddedId ? (
              <Link className="btn" to={`/verify/${encodeURIComponent(foreign.embeddedId)}`}>
                Check {foreign.embeddedId} on this portal instead
              </Link>
            ) : (
              <Link className="btn ghost" to="/">
                Enter the certificate ID manually
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
