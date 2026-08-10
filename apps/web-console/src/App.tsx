import { useMemo } from "react";

import { createHttpForgeXClient } from "./api.js";
import { RequirementWorkbench } from "./requirement-workbench.js";

export function App() {
  const client = useMemo(() => {
    const developmentToken = import.meta.env.DEV
      ? import.meta.env.VITE_FORGEX_DEV_TOKEN
      : undefined;
    return createHttpForgeXClient({
      ...(developmentToken
        ? { authorization: `Bearer ${developmentToken}` }
        : {}),
    });
  }, []);

  return (
    <RequirementWorkbench
      client={client}
      projectName={import.meta.env.VITE_FORGEX_PROJECT_NAME ?? "我的项目"}
    />
  );
}
