import "dotenv/config";
import express from "express";
import { initWA, getQR, onMessage, sendText } from "./wa";
import { handleMessage } from "./bot";
import { sendPix } from "./media";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/status", (_, res) => res.json({ status: getQR().status }));
app.get("/qr", (_, res) => {
  const { status, dataUrl } = getQR();
  if (status === "NEEDS_QR" && dataUrl) return res.json({ status, dataUrl });
  return res.json({ status });
});
app.get("/qr.png", (_, res) => {
  const { status, dataUrl } = getQR();
  if (status !== "NEEDS_QR" || !dataUrl) return res.status(204).end();
  const base64 = dataUrl.split(",")[1];
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.end(Buffer.from(base64, "base64"));
});
app.post("/send-text", async (req, res) => {
  const { to, message } = req.body;
  try {
    const r = await sendText(to, message);
    res.json({ id: r.id.id, ack: r.ack });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/send-pix", async (req, res) => {
  const { to, amount, description } = req.body;
  try {
    await sendPix(to, Number(amount), description);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// roteamento de mensagens recebidas
onMessage(async (msg) => {
  try {
    await handleMessage(msg);
  } catch (e) {
    console.error("[router] erro:", e);
  }
});

const port = Number(process.env.PORT || 3000);

// Inicie WhatsApp se habilitado
(async () => {
  try {
    if (process.env.USE_WA === "true") {
      await initWA();
    }
    app.listen(port, "0.0.0.0", () => console.log("HTTP on", port));
  } catch (err) {
    console.error("[bootstrap] falha ao iniciar:", err);
    process.exit(1);
  }
})();

// encerramento gracioso
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
