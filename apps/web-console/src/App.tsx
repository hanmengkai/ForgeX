import { useMemo } from "react";

import { createHttpForgeXClient } from "./api.js";
import { RequirementWorkbench } from "./requirement-workbench.js";
import { SessionGate } from "./session-gate.js";

export function App() {
  const developmentToken = import.meta.env.DEV
    ? import.meta.env.VITE_FORGEX_DEV_TOKEN
    : undefined;
  const client = useMemo(() => {
    return createHttpForgeXClient({
      ...(developmentToken
        ? { authorization: `Bearer ${developmentToken}` }
        : {}),
    });
  }, []);

  const projectName = import.meta.env.VITE_FORGEX_PROJECT_NAME ?? "我的项目";

  if (!developmentToken) {
    return <SessionGate client={client} projectName={projectName} />;
  }

  return <RequirementWorkbench client={client} projectName={projectName} />;
}
