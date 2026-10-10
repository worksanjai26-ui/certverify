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

  async function checkWholeCertificate(file) {
    setMessage('');
    setForeign(null);
    navigate('/verify', { state: { file } });
    stop();
  }

  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div>
        <div className="eyebrow">Employer scans certificate</div>
        <h1>Check the certificate you were given</h1>
        <p className="lead">
          The official copy ends with a verification page carrying the QR code. Scanning the QR alone only proves the
          code is genuine, not that the paper it is printed on is. A one-shot photo of the <strong>whole
          certificate</strong> lets us also read what is printed on it and compare it with the registry.
        </p>
        <div className="callout">
          <strong>One photo is the strongest check.</strong> We read the QR <em>and</em> the printed name, roll number
          and marks. If the paper and the QR disagree (for example the certificate says 90% but the QR says 77%), the
          certificate is flagged as a fake and the college is notified.
        </div>
      </div>

      <div className="stack">
        <div className="card stack">
          <div className="card-title">Photo of the whole certificate — recommended</div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Camera or file. Hold the certificate flat, fill the frame, and use good light so the text is readable.
          </p>
          <label className="btn primary block camera-btn">
            📷 Take a photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) checkWholeCertificate(f);
              }}
            />
          </label>
          <FileDrop
            onFile={checkWholeCertificate}
            accept="image/*"
            title="Or upload a photo of the certificate"
            hint="PNG, JPG or HEIC from your phone, showing the certificate including its QR code"
          />
        </div>

        <div className="card stack">
          <div className="card-title">Scan just the QR code</div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Quick, but only checks the code itself. Compare the details below with the paper, and check the document
            afterwards for the full page-by-page comparison.
          </p>
          {/* Always in the layout: the library measures this element before React re-renders. */}
          <div id="qr-reader" />
          <div id="qr-file-reader" style={{ display: 'none' }} />
          {scanning ? (
            <button className="btn ghost block" onClick={stop}>
              Stop camera
            </button>
          ) : (
            <button className="btn block" onClick={start}>
              Start camera
            </button>
          )}
          <FileDrop
            onFile={scanImage}
            accept="image/*"
            title="Or upload a photo / screenshot of the QR"
            hint="PNG, JPG or HEIC from your phone"
          />
        </div>

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
