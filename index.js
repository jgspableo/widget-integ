import app from "./app.js";

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

// Render requires binding to 0.0.0.0 and using the PORT it provides. :contentReference[oaicite:2]{index=2}
app.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${PORT}`);
});
