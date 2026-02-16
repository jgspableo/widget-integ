import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.disable("x-powered-by");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Static files
app.use(express.static(path.join(__dirname, "public")));

// Health check (Render + sanity)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mapua-uef-widget",
    time: new Date().toISOString(),
  });
});

// Root page (quick confirmation)
app.get("/", (req, res) => {
  res.type("html").send(`
    <h2>Mapua UEF Widget Service</h2>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/widget.html">/widget.html</a> (Noodle Factory widget)</li>
      <li><a href="/uef.js">/uef.js</a> (UEF loader script placeholder)</li>
    </ul>
  `);
});

export default app;
