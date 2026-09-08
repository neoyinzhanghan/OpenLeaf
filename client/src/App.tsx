import { Navigate, Route, Routes } from "react-router-dom";
import { EditorPage } from "./pages/EditorPage";
import { GuestInactive, GuestLogin } from "./pages/GuestLogin";
import { ProjectList } from "./pages/ProjectList";
import { useSession } from "./session/SessionContext";

export function App() {
  const { session } = useSession();

  if (session.kind === "loading") {
    return <div className="guest-shell guest-loading">Loading…</div>;
  }

  // Arrived through a share link: only that one project exists as far as this tab is concerned.
  if (session.kind === "guest-inactive") return <GuestInactive reason={session.reason} />;
  if (session.kind === "guest-login") return <GuestLogin share={session.share} />;
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
