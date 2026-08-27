import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Sessions from "./Sessions";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// Two screens, one bundle: the debugger, and the dashboard of every live server
// (the server maps /sessions to this same index.html).
const page = location.pathname === "/sessions" ? <Sessions /> : <App />;
createRoot(document.getElementById("root")!).render(page);
