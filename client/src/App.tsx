import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { EditorPage } from "./pages/EditorPage";
import { GuestInactive, GuestLogin } from "./pages/GuestLogin";
import { HostLogin } from "./pages/HostLogin";
import { LibraryPage } from "./pages/LibraryPage";
import { LibraryShareGuestPage } from "./pages/LibraryShareGuestPage";
import { ProjectList } from "./pages/ProjectList";
import { useSession } from "./session/SessionContext";

export function App() {
  const { session } = useSession();
  const location = useLocation();

  // Paper-share invites ride the host gateway; token in the path is the credential —
  // do not force host login before the guest viewer can load.
  if (location.pathname.startsWith("/lib-share/")) {
    return (
      <Routes>
        <Route path="/lib-share/:token" element={<LibraryShareGuestPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  if (session.kind === "loading") {
    return <div className="guest-shell guest-loading">Loading…</div>;
  }

  if (session.kind === "host-login") return <HostLogin />;
  // Arrived through a share link: only that one project exists as far as this tab is concerned.
  if (session.kind === "guest-inactive") return <GuestInactive reason={session.reason} />;
  if (session.kind === "guest-login") return <GuestLogin share={session.share} linkOk={session.linkOk} />;
  if (session.kind === "guest") {
    const home = `/p/${encodeURIComponent(session.share.projectId)}`;
    return (
      <Routes>
        <Route path="/p/:id" element={<GuestProjectGuard projectId={session.share.projectId} />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<ProjectList />} />
      <Route path="/library" element={<LibraryPage />} />
      <Route path="/lib-share/:token" element={<LibraryShareGuestPage />} />
      <Route path="/p/:id" element={<EditorPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function GuestProjectGuard({ projectId }: { projectId: string }) {
  const path = window.location.pathname;
  const expected = `/p/${encodeURIComponent(projectId)}`;
  if (path !== expected) return <Navigate to={expected} replace />;
  return <EditorPage />;
}
