import React from "react";
import ReactDOM from "react-dom/client";
// Note: /react, not the Next.js path Vercel's setup page shows by default.
import { Analytics } from "@vercel/analytics/react";
import MatchweekBoard from "./MatchweekBoard.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MatchweekBoard />
    <Analytics />
  </React.StrictMode>
);
