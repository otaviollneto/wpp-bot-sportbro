import makeWASocket, {
  AnyMessageContent,
  BaileysEventMap,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WAMessage,
  WAMessageKey,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import { Boom } from "@hapi/boom";

const dataPath =
  process.env.WA_BAILEYS_SESSION_DIR ||
  process.env.WAWEB_SESSION_DIR ||
  "/root/wpp-session";

type WaStatus =
  | "INIT"
  | "NEEDS_QR"
  | "READY"
  | "AUTH_FAIL"
  | "DISCONNECTED"
  | "LOADING";

let waStatus: WaStatus = "INIT";
let lastQRDataUrl: string | null = null;
let initializing = false;

let sock: ReturnType<typeof makeWASocket> | null = null;

export function getQR() {
  return { status: waStatus, dataUrl: lastQRDataUrl };
}

/** =========================
 *  Normalização de destino
 *  ========================= */

function isBaileysJid(to: string) {
  // individual: 55...@s.whatsapp.net
  // group: ...@g.us
  // broadcast: ...@broadcast
  return /@(s\.whatsapp\.net|g\.us|broadcast)$/i.test(to || "");
}

function normalizePhoneToDigits(to: string) {
  let digits = (to || "").replace(/\D/g, "");
  if (!digits) return "";
  // se vier 11 dígitos (DDD+9), prefixa 55
  if (digits.length === 11) digits = "55" + digits;
  // se não tiver 55, prefixa 55
  if (!digits.startsWith("55")) digits = "55" + digits;
  return digits;
}

async function ensureJid(to: string) {
  if (!to) throw new Error("Destino não informado");
  if (isBaileysJid(to)) return to;

  const digits = normalizePhoneToDigits(to);
  if (!digits) throw new Error("Número não informado");

  // Baileys usa @s.whatsapp.net para chat individual
  return `${digits}@s.whatsapp.net`;
}

/** =========================
 *  Inicialização / Reconexão
 *  ========================= */

export async function initWA() {
  if (initializing) return;
  initializing = true;

  const logger = pino({ level: process.env.WA_LOG_LEVEL || "silent" });

  const { state, saveCreds } = await useMultiFileAuthState(dataPath);

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: () => false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // QR + status + reconexão
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr) {
      try {
        lastQRDataUrl = await QRCode.toDataURL(qr);
        waStatus = "NEEDS_QR";
        console.log("[WA] QR atualizado");
      } catch (e) {
        console.error("[WA] erro ao gerar QR:", e);
      }
    }

    if (isNewLogin) {
      waStatus = "LOADING";
      console.log("[WA] login novo detectado (carregando...)");
    }

    if (connection === "open") {
      waStatus = "READY";
      lastQRDataUrl = null;
      console.log("[WA] pronto (Baileys)");
    }

    if (connection === "close") {
      waStatus = "DISCONNECTED";

      const err = lastDisconnect?.error as Boom | undefined;
      const code = err?.output?.statusCode;

      const shouldReconnect = code !== DisconnectReason.loggedOut;

      console.warn("[WA] desconectado:", {
        code,
        shouldReconnect,
        message: err?.message,
      });

      if (!shouldReconnect) {
        waStatus = "AUTH_FAIL";
        console.error(
          "[WA] loggedOut: apague a sessão e autentique novamente.",
        );
        return;
      }

      // reconecta com pequeno delay
      setTimeout(() => {
        // reinicia tudo (novo socket)
        initializing = false;
        initWA().catch(() => {});
      }, 1500);
    }
  });

  waStatus = "LOADING";
  console.log("[WA] inicializando (Baileys)...");
}

/** =========================
 *  Envio de mensagens
 *  ========================= */

async function assertReady() {
  if (!sock) throw new Error("Socket não inicializado");
  if (waStatus !== "READY") throw new Error("WhatsApp não está READY");
}

export async function sendText(to: string, text: string) {
  await assertReady();
  const jid = await ensureJid(to);

  const content: AnyMessageContent = { text: text || "" };
  const r = await sock!.sendMessage(jid, content);

  return r;
}

export async function sendImageBuffer(
  to: string,
  buffer: Buffer,
  mimeType: string,
  filename: string,
  caption?: string,
) {
  await assertReady();
  const jid = await ensureJid(to);

  // Baileys aceita buffer direto
  const r = await sock!.sendMessage(jid, {
    image: buffer,
    mimetype: mimeType || "image/png",
    fileName: filename || "image",
    caption: caption || undefined,
  });

  return r;
}

export async function sendImageBase64(
  to: string,
  dataUrl: string,
  filename = "image.png",
  caption?: string,
) {
  let mimeType = "image/png";
  let base64 = dataUrl;

  const parts = (dataUrl || "").split(",");
  if (parts.length === 2) {
    base64 = parts[1];
    const match = parts[0].match(/data:(.*?);base64/i);
    if (match?.[1]) mimeType = match[1];
  }

  const buf = Buffer.from(base64, "base64");
  return sendImageBuffer(to, buf, mimeType, filename, caption);
}

/** =========================
 *  Mensagens recebidas (Adapter)
 *  ========================= */

export type BaileysIncomingMessage = {
  id: string;
  from: string; // jid
  body: string;
  isGroup: boolean;
  participant?: string;
  pushName?: string;
  raw: WAMessage;
};

export type OnMessageHandler = (msg: BaileysIncomingMessage) => void;

export function onMessage(handler: OnMessageHandler) {
  if (!sock) {
    // registra “depois”; você chamou onMessage antes do initWA no server.ts
    // então guardamos o handler e registramos quando o socket existir
    pendingHandlers.push(handler);
    return;
  }
  registerMessageHandler(handler);
}

// guarda handlers se server.ts registrar antes do initWA
const pendingHandlers: OnMessageHandler[] = [];

function registerMessageHandler(handler: OnMessageHandler) {
  if (!sock) return;

  sock.ev.on("messages.upsert", (ev) => {
    if (waStatus !== "READY") return;
    if (ev.type !== "notify") return;

    for (const m of ev.messages || []) {
      try {
        if (!m.message) continue;
        if (m.key?.fromMe) continue;

        const from = m.key.remoteJid || "";
        const isGroup = isJidGroup(from) ?? false;
        const participant = isGroup
          ? m.key.participant || undefined
          : undefined;

        const body =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          "";

        const id = m.key.id || `${from}:${Date.now()}`;

        const incoming: BaileysIncomingMessage = {
          id,
          from,
          body: String(body || ""),
          isGroup,
          participant,
          pushName: m.pushName || undefined,
          raw: m,
        };

        handler(incoming);
      } catch (e) {
        console.error("[WA] erro ao processar msg:", e);
      }
    }
  });
}

// quando initWA criar sock, registramos os handlers pendentes
function flushPendingHandlers() {
  if (!sock) return;
  while (pendingHandlers.length) {
    const h = pendingHandlers.shift()!;
    registerMessageHandler(h);
  }
}

// “gancho” simples: assim que sock existir, tenta flush
const _flushTimer = setInterval(() => {
  if (sock) {
    flushPendingHandlers();
    clearInterval(_flushTimer);
  }
}, 100);
