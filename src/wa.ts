import { Client, LocalAuth, MessageMedia, Message } from "whatsapp-web.js";
import QRCode from "qrcode";
import puppeteer from "puppeteer";

const dataPath = process.env.WAWEB_SESSION_DIR || ".wa-session";
const WEB_VERSION = process.env.WWEBJS_WEB_VERSION || undefined;
const WEB_VERSION_CACHE: any = WEB_VERSION ? { type: "none" } : undefined;

export const client = new Client({
  authStrategy: new LocalAuth({ dataPath, clientId: "default" }),
  puppeteer: {
    headless: true,
    executablePath: puppeteer.executablePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
  ...(WEB_VERSION ? { webVersion: WEB_VERSION } : {}),
  ...(WEB_VERSION_CACHE ? { webVersionCache: WEB_VERSION_CACHE } : {}),
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
let initialized = false;

export function getQR() {
  // agora você sabe se precisa exibir o QR ou não
  return { status: waStatus, dataUrl: lastQRDataUrl };
}

export async function initWA() {
  if (initialized) return; // evita múltiplas inicializações
  initialized = true;

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
    // NÃO zere lastQRDataUrl aqui. Deixe para o cliente decidir se usa.
  });

  client.on("loading_screen", (percent, message) => {
    waStatus = "LOADING";
    console.log("[WA] loading:", percent, message);
  });
  client.on("change_state", (s) => console.log("[WA] state:", s));
  client.on("disconnected", (r) => {
    waStatus = "DISCONNECTED";
    console.log("[WA] desconectado:", r);
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
