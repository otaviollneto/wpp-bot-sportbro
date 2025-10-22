import { Client, LocalAuth, MessageMedia, Message } from "whatsapp-web.js";
import QRCode from "qrcode";

/** =========================
 *  Config (.env)
 * ========================= */
const dataPath = process.env.WAWEB_SESSION_DIR || ".wa-session";
const WEB_VERSION = process.env.WWEBJS_WEB_VERSION || undefined;
const WEB_VERSION_CACHE: any = WEB_VERSION ? { type: "none" } : undefined;

/** =========================
 *  Status / QR em memória
 * ========================= */
type WaStatus =
  | "INIT"
  | "NEEDS_QR"
  | "READY"
  | "AUTH_FAIL"
  | "DISCONNECTED"
  | "LOADING";

let lastQRDataUrl: string | null = null;
let waStatus: WaStatus = "INIT";

/** =========================
 *  Client (preenchido no init)
 * ========================= */
export let client: Client;
let initialized = false;

export function getQR() {
  return { status: waStatus, dataUrl: lastQRDataUrl };
}

/** =========================
 *  Chrome no Heroku (flags)
 * ========================= */
function guessChromeExecutablePath(): string | undefined {
  // Prioridades (várias plataformas/setups):
  // 1) explicitamente informado
  if (process.env.PUPPETEER_EXECUTABLE_PATH)
    return process.env.PUPPETEER_EXECUTABLE_PATH;

  // 2) novo buildpack oficial do Heroku (chrome-for-testing)
  if (process.env.GOOGLE_CHROME_FOR_TESTING_BIN)
    return process.env.GOOGLE_CHROME_FOR_TESTING_BIN;

  // 3) variáveis tradicionais usadas por outros buildpacks
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  // 4) caminhos comuns em containers/Heroku layers
  const guesses = [
    "/app/.cache/chrome-for-testing/chrome",
    "/app/.apt/usr/bin/google-chrome",
    "/usr/bin/google-chrome",
  ];
  for (const p of guesses) return p;

  return undefined; // deixa o puppeteer resolver (quando aplicável)
}

function puppeteerConfig(): any {
  return {
    headless: true,
    executablePath: guessChromeExecutablePath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  };
}

/** =========================
 *  Inicialização com retry
 * ========================= */
export async function initWA() {
  if (initialized) return;
  initialized = true;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath, clientId: "default" }),
    puppeteer: puppeteerConfig(),
    ...(WEB_VERSION ? { webVersion: WEB_VERSION } : {}),
    ...(WEB_VERSION_CACHE ? { webVersionCache: WEB_VERSION_CACHE } : {}),
  });

  client.on("qr", async (qr) => {
    try {
      lastQRDataUrl = await QRCode.toDataURL(qr);
      waStatus = "NEEDS_QR";
      console.log("[WA] QR atualizado — escaneie no app para autenticar.");
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
    lastQRDataUrl = null; // força novo QR numa próxima inicialização
    console.warn("[WA] desconectado:", reason);
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

/** =========================
 *  Envio de mensagens
 * ========================= */
async function ensureJid(toE164: string) {
  if (!client) throw new Error("WhatsApp Client não inicializado");
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

/** =========================
 *  Registro de handlers
 * ========================= */
export type OnMessageHandler = (msg: Message) => void;

export function onMessage(h: OnMessageHandler) {
  client?.on("message", h);
}
