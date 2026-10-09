import { lazy, Suspense } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth.jsx';
import { AdminLayout, PublicLayout } from './components/Layouts.jsx';
import { Loading } from './components/ui.jsx';
import Home from './pages/Home.jsx';
import Verify from './pages/Verify.jsx';
import Login from './pages/admin/Login.jsx';
import Dashboard from './pages/admin/Dashboard.jsx';
import Upload from './pages/admin/Upload.jsx';
import Certificates from './pages/admin/Certificates.jsx';
import CertificateDetail from './pages/admin/CertificateDetail.jsx';
import Verifications from './pages/admin/Verifications.jsx';
import Audit from './pages/admin/Audit.jsx';

// The camera/QR library is large; only load it when someone opens the scanner.
const Scan = lazy(() => import('./pages/Scan.jsx'));

function NotFound() {
  return (
    <div className="container" style={{ padding: '64px 16px' }}>
      <h1>Page not found</h1>
      <p className="lead">That address doesn't exist on this portal.</p>
      <Link className="btn primary" to="/">
        Go to verification
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<Home />} />
        <Route path="verify" element={<Verify />} />
        <Route path="verify/:id" element={<Verify />} />
        <Route
          path="scan"
          element={
            <Suspense fallback={<Loading label="Loading scanner…" />}>
              <Scan />
            </Suspense>
          }
        />
      </Route>
      <Route path="admin/login" element={<Login />} />
      <Route
        path="admin"
        element={
          <RequireAuth>
            <AdminLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="upload" element={<Upload />} />
        <Route path="certificates" element={<Certificates />} />
        <Route path="certificates/:id" element={<CertificateDetail />} />
        <Route path="verifications" element={<Verifications />} />
        <Route path="audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
