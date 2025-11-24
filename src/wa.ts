import { Client, LocalAuth, MessageMedia, Message } from "whatsapp-web.js";
import QRCode from "qrcode";

const dataPath = process.env.WAWEB_SESSION_DIR || "/root/wpp-session";
const chromePath = process.env.CHROME_PATH || undefined;

const puppeteerArgs = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-software-rasterizer",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--no-first-run",
  "--no-zygote",
  "--disable-features=TranslateUI,BlinkGenPropertyTrees",
  "--ignore-certificate-errors",
  "--ignore-certificate-errors-spki-list",
  "--window-size=1280,800",
];

export const client = new Client({
  authStrategy: new LocalAuth({ dataPath, clientId: "default" }),
  puppeteer: {
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: puppeteerArgs,
  },
  // se quiser, pode usar cache remoto de versão depois, mas deixa simples por enquanto
  // webVersionCache: {
  //   type: "remote",
  //   remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/last.json",
  // },
});

let lastQRDataUrl: string | null = null;

type WaStatus =
  | "INIT"
  | "NEEDS_QR"
  | "READY"
  | "AUTH_FAIL"
  | "DISCONNECTED"
  | "LOADING";

let waStatus: WaStatus = "INIT";
let initializing = false;

export function getQR() {
  return { status: waStatus, dataUrl: lastQRDataUrl };
}

export async function initWA() {
  if (initializing) return;
  initializing = true;

  client.on("qr", async (qr) => {
    try {
      lastQRDataUrl = await QRCode.toDataURL(qr);
      waStatus = "NEEDS_QR";
      console.log("[WA] QR atualizado");
    } catch (e) {
      console.error("[WA] erro ao gerar QR:", e);
    }
  });

  client.on("ready", () => {
    waStatus = "READY";
    console.log("[WA] pronto");
  });

  client.on("loading_screen", (percent, message) => {
    waStatus = "LOADING";
    console.log("[WA] loading:", percent, message);
  });

  client.on("change_state", (s) => console.log("[WA] state:", s));

  client.on("disconnected", (reason) => {
    waStatus = "DISCONNECTED";
    console.warn("[WA] desconectado:", reason);
    setTimeout(() => initializeWithRetry().catch(() => {}), 1500);
  });

  client.on("auth_failure", (m) => {
    waStatus = "AUTH_FAIL";
    console.error("[WA] auth_failure:", m);
  });

  await initializeWithRetry();
}

async function initializeWithRetry(maxAttempts = 3) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      console.log(`[WA] initialize tentativa ${attempt}/${maxAttempts}`);
      await client.initialize();
      return;
    } catch (err: any) {
      const msg = String(err?.message || err);
      const isNavErr =
        msg.includes("Navigation failed because browser has disconnected") ||
        msg.includes("Execution context was destroyed") ||
        msg.includes("Most likely because of a navigation") ||
        msg.includes("Cannot read properties of null");

      if (isNavErr && attempt < maxAttempts) {
        console.warn(
          "[WA] initialize falhou (navegação). Retentando em 1.5s...",
          msg
        );
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      console.error("[WA] initialize erro fatal:", err);
      throw err;
    }
  }
  throw new Error("Falha ao inicializar o WhatsApp após múltiplas tentativas.");
}

async function ensureJid(toE164: string) {
  const number = (toE164 || "").replace(/\D/g, "");
  if (!number) throw new Error("Número não informado");
  const jid = await client.getNumberId(number);
  if (!jid) throw new Error("Número inválido ou não registrado no WhatsApp");
  return jid._serialized;
}

export async function sendText(toE164: string, text: string) {
  const jid = await ensureJid(toE164);
  return client.sendMessage(jid, text);
}

export async function sendImageBuffer(
  toE164: string,
  buffer: Buffer,
  mimeType: string,
  filename: string
) {
  const jid = await ensureJid(toE164);
  const base64 = buffer.toString("base64");
  const media = new MessageMedia(mimeType, base64, filename);
  return client.sendMessage(jid, media);
}

export async function sendImageBase64(
  toE164: string,
  dataUrl: string,
  filename = "image.png",
  caption?: string
) {
  const jid = await ensureJid(toE164);

  let mimeType = "image/png";
  let base64 = dataUrl;

  const parts = dataUrl.split(",");
  if (parts.length === 2) {
    base64 = parts[1];
    const match = parts[0].match(/data:(.*?);base64/);
    if (match && match[1]) {
      mimeType = match[1];
    }
  }

  const media = new MessageMedia(mimeType, base64, filename);
  const options = caption ? { caption } : undefined;

  return client.sendMessage(jid, media, options as any);
}

export type OnMessageHandler = (msg: Message) => void;

export function onMessage(h: OnMessageHandler) {
  client.on("message", h);
}
