import { Client, LocalAuth, MessageMedia, Message } from "whatsapp-web.js";
import QRCode from "qrcode";
import puppeteer from "puppeteer";

const dataPath = process.env.WAWEB_SESSION_DIR || ".wa-session";
const WEB_VERSION = process.env.WWEBJS_WEB_VERSION || undefined;
const WEB_VERSION_CACHE: any = WEB_VERSION ? { type: "none" } : undefined;

type WaStatus =
  | "INIT"
  | "NEEDS_QR"
  | "READY"
  | "AUTH_FAIL"
  | "DISCONNECTED"
  | "LOADING";

let lastQRDataUrl: string | null = null;
let waStatus: WaStatus = "INIT";
let initialized = false;

function resolveChromePath(): string | undefined {
  // Prioriza variáveis que o buildpack chrome-for-testing injeta
  return (
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.GOOGLE_CHROME_FOR_TESTING_BIN ||
    process.env.CHROME_BIN ||
    process.env.CHROME_PATH ||
    puppeteer.executablePath()
  );
}

function puppeteerOptions() {
  return {
    headless: true,
    executablePath: resolveChromePath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      // evita problemas de IPC em ambientes limitados
      "--single-process",
    ],
  };
}

export const client = new Client({
  authStrategy: new LocalAuth({ dataPath, clientId: "default" }),
  puppeteer: puppeteerOptions(),
  ...(WEB_VERSION ? { webVersion: WEB_VERSION } : {}),
  ...(WEB_VERSION_CACHE ? { webVersionCache: WEB_VERSION_CACHE } : {}),
});

export function getQR() {
  return { status: waStatus, dataUrl: lastQRDataUrl };
}

export async function initWA() {
  if (initialized) return;
  initialized = true;

  client.on("qr", async (qr) => {
    try {
      lastQRDataUrl = await QRCode.toDataURL(qr);
      waStatus = "NEEDS_QR";
      console.log("[WA] QR atualizado (escaneie para autenticar).");
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

  client.on("disconnected", (r) => {
    waStatus = "DISCONNECTED";
    lastQRDataUrl = null;
    console.warn("[WA] desconectado:", r);
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
      await client.initialize();
      return;
    } catch (err: any) {
      const msg = String(err?.message || err);
      const isNavErr =
        msg.includes("Execution context was destroyed") ||
        msg.includes("Most likely because of a navigation") ||
        msg.includes("Cannot read properties of null");
      if (isNavErr && attempt < maxAttempts) {
        console.warn(
          `[WA] initialize falhou por navegação (tentativa ${attempt}/${maxAttempts}) — retry em 1.5s...`
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

export async function sendImageBase64(
  toE164: string,
  base64: string,
  filename = "pix.png",
  caption?: string
) {
  const jid = await ensureJid(toE164);
  const media = new MessageMedia(
    "image/png",
    base64.split(",")[1] || base64,
    filename
  );
  return client.sendMessage(jid, media, { caption });
}

export type OnMessageHandler = (msg: Message) => void;
export function onMessage(h: OnMessageHandler) {
  client.on("message", h);
}
