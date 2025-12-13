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

function normalizeDigits(input: string) {
  return (input || "").replace(/\D/g, "");
}

function withBrazilCountry(d: string) {
  if (!d) return "";
  if (d.startsWith("55")) return d;
  return "55" + d;
}

/**
 * Gera tentativas prováveis (principalmente BR):
 * - mantém como está
 * - força prefixo 55
 * - se ficar 12 (55 + 10), tenta inserir 9 após DDD (55 + DDD + 9 + XXXXXXXX)
 * - se ficar 10 (DDD + 8), tenta inserir 9 (DDD + 9 + XXXXXXXX) e depois prefixa 55
 */
function buildCandidates(raw: string) {
  const base = normalizeDigits(raw);
  const cands = new Set<string>();

  if (!base) return [];

  // 1) como está + com 55
  cands.add(base);
  cands.add(withBrazilCountry(base));

  const br = withBrazilCountry(base);

  // Se veio 10 dígitos (DDD+8), tenta virar 11 (DDD+9+8)
  if (base.length === 10) {
    const ddd = base.slice(0, 2);
    const rest = base.slice(2);
    cands.add(ddd + "9" + rest);
    cands.add("55" + ddd + "9" + rest);
  }

  // Se ficou 12 (55 + DDD + 8), tenta virar 13 inserindo 9
  if (br.length === 12 && br.startsWith("55")) {
    const ddd = br.slice(2, 4);
    const rest = br.slice(4); // 8 dígitos
    cands.add("55" + ddd + "9" + rest);
  }

  // Se ficou 11 sem 55 (DDD+9+8), garante com 55 também
  if (base.length === 11) {
    cands.add("55" + base);
  }

  return Array.from(cands).filter((x) => x.length >= 10 && x.length <= 13);
}

async function ensureJid(toE164: string) {
  const raw = (toE164 || "").trim();
  const candidates = buildCandidates(raw);

  if (!candidates.length) throw new Error("Número não informado");

  // tenta getNumberId nas variações
  for (const digits of candidates) {
    try {
      const jid = await client.getNumberId(digits);
      if (jid?._serialized) return jid._serialized;
    } catch {
      // segue para próxima variação
    }
  }

  // fallback: tentar enviar direto (sem validação prévia)
  // OBS: isso não garante que existe, mas evita falso negativo do getNumberId
  const best = candidates.find((c) => c.startsWith("55")) || candidates[0];
  const directJid = `${best}@c.us`;

  // Se você preferir NÃO fazer fallback, comente as 2 linhas abaixo
  return directJid;

  // Se não quiser fallback, use:
  // throw new Error(`Número inválido ou não registrado no WhatsApp: tentativas=${candidates.join(",")}`);
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
