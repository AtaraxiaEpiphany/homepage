import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/courier-prime/400.css";
import "@fontsource/courier-prime/700.css";
import App from "./App.js";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
