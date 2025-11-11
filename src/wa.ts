import { Client, LocalAuth, MessageMedia, Message } from "whatsapp-web.js";
import QRCode from "qrcode";
// ⬇️ você pode remover essa importação se não for usar executablePath do Puppeteer
// import puppeteer from "puppeteer";

const dataPath = process.env.WAWEB_SESSION_DIR || "C:\\wpp-session"; // evite OneDrive
const WEB_VERSION = process.env.WWEBJS_WEB_VERSION || undefined;
const WEB_VERSION_CACHE: any = WEB_VERSION ? { type: "none" } : undefined;

// se quiser usar seu Chrome/Edge, defina CHROME_PATH no .env
const chromePath = process.env.CHROME_PATH || undefined;

export const client = new Client({
  authStrategy: new LocalAuth({ dataPath, clientId: "default" }),
  puppeteer: {
    // para depuração ponha false e veja a janela abrindo:
    headless: "false" as unknown as boolean | "chrome" | undefined, // 'new' melhora estabilidade; use false p/ debug
    // NÃO force executablePath do puppeteer a menos que saiba a versão.
    // executablePath: chromePath || puppeteer.executablePath(),
    ...(chromePath ? { executablePath: chromePath } : {}),

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
      "--window-size=1280,800",
    ],
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
    // tenta reerguer com um pequeno backoff
    setTimeout(() => initializeWithRetry().catch(() => {}), 1500);
  });

  client.on("auth_failure", (m) => {
    waStatus = "AUTH_FAIL";
    console.error("[WA] auth_failure:", m);
  });

  // também loga quando o próprio browser cai
  client.pupBrowser?.on("disconnected", () => {
    console.warn("[WA] browser disconnected");
    waStatus = "DISCONNECTED";
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
          `[WA] initialize falhou (navegação). Retentando em 1.5s...`,
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
