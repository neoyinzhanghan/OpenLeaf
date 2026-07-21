import { Navigate, Route, Routes } from "react-router-dom";
import { EditorPage } from "./pages/EditorPage";
import { ProjectList } from "./pages/ProjectList";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<ProjectList />} />
      <Route path="/p/:id" element={<EditorPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
