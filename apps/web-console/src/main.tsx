import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { initializeColorTheme } from "./theme.js";
import "./styles.css";

initializeColorTheme();

const root = document.getElementById("root");
if (!root) {
  throw new Error("ForgeX 页面缺少根节点");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
