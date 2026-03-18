import { CollapseProvider, CollapseRecorder } from "@collapse/react";

function getToken(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? "";
}

export function App() {
  return (
    <CollapseProvider token={getToken}>
      <CollapseRecorder />
    </CollapseProvider>
  );
}
