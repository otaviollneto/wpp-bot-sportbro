import OpenAI from "openai";
import { Session } from "./type";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
export const TRIGGER_PHRASE = (process.env.TRIGGER_PHRASE || "Olá Bro").trim();
export const EXTRA_TRIGGERS = [
  "iniciar atendimento bro",
  "iniciar atendimento do bro",
  "iniciar atendimento",
  "começar atendimento",
].map((t) => norm(t));
export const END_TRIGGERS = [
  "fim", // já existia
  "encerrar atendimento bro", // você falando
  "fim atendimento bro", // outra variação
  "encerrar atendimento", // genérico
  "fim atendimento", // genérico
  "obrigado bro", // agradecimento
  "obrigada bro", // agradecimento
  "valeu",
  "valeu bro",
  "agradeço",
  "agradeço bro",
  "vlw",
].map((t) => norm(t));

export function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export async function classifyIssue(
  text: string
): Promise<
  | "iss_pwd"
  | "iss_cat"
  | "iss_size"
  | "iss_team"
  | "iss_cancel"
  | "choose_event"
  | "iss_transfer"
  | "unknown"
> {
  const prompt = `
Classifique a solicitação do usuário em UMA destas chaves:
- iss_pwd (esqueci a senha, recuperar senha, redefinir)
- iss_cat (troca de categoria)
- iss_size (troca de tamanho de camiseta)
- iss_team (troca de nome da equipe, equipe)
- iss_cancel (cancelar inscrição, estorno)
- choose_event (quando ele quer escolher/alterar evento)
- iss_transfer (transferir inscrição para outro titular)
Responda apenas com a chave. Texto: "${text}"
`;
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: "Responda APENAS com a chave exata." },
        { role: "user", content: prompt },
      ],
    });
    const raw = r.choices[0]?.message?.content?.trim() || "";
    const key = norm(raw).replace(/\s+/g, "_");
    const allowed = new Set([
      "iss_pwd",
      "iss_cat",
      "iss_size",
      "iss_team",
      "iss_cancel",
      "choose_event",
      "iss_transfer",
    ]);
    return allowed.has(key) ? (key as any) : "unknown";
  } catch {
    // Fallback por palavras-chave
    const t = norm(text);
    if (t.includes("senha")) return "iss_pwd";
    if (t.includes("categoria")) return "iss_cat";
    if (t.includes("camiseta") || t.includes("tamanho")) return "iss_size";
    if (t.includes("equipe")) return "iss_team";
    if (t.includes("cancel")) return "iss_cancel";
    if (t.includes("evento")) return "choose_event";
    if (
      t.includes("titular") ||
      t.includes("titularidade") ||
      t.includes("transferir") ||
      t.includes("transferencia") ||
      t.includes("transferência")
    )
      return "iss_transfer";
    return "unknown";
  }
}

export function isSwitchEvent(s: string) {
  const t = norm(` ${s} `);
  const keys = [
    " trocar ",
    " troca ",
    " trocar de evento ",
    " trocar evento ",
    " mudar de evento ",
    " mudar evento ",
    " mudar ",
    " outro evento ",
    " escolher outro ",
    " escolher outro evento ",
    " alterar evento ",
    " voltar evento ",
    " trocar o evento ",
    " selecionar outro evento ",
  ];
  return t.trim() === "0" || keys.some((k) => t.includes(k));
}

export function isGoMenu(s: string) {
  const t = norm(` ${s} `);
  return [
    " menu ",
    " voltar ",
    " inicio ",
    " início ",
    " comecar de novo ",
    " começar de novo ",
    " voltar ao menu ",
    " voltar para o menu ",
    " home ",
  ].some((k) => t.includes(k));
}

// ======= Novas funções de interpretação pós-atendimento =======

/** Respostas curtas/educadas que indicam término natural da conversa */
export function isPoliteEnd(s: string) {
  const t = norm(` ${s} `);
  return [
    " obrigado ",
    " obrigada ",
    " valeu ",
    " agradeco ",
    " agradeço ",
    " perfeito ",
    " deu certo ",
    " resolveu ",
    " tudo certo ",
    " ok ",
    " tranquilo ",
    " blz ",
    " beleza ",
    " fechou ",
    " show ",
  ].some((k) => t.includes(k));
}

/** Indica explicitamente que o usuário quer continuar/ajuda de novo */
export function wantsMoreHelp(s: string) {
  const t = norm(` ${s} `);
  return (
    [
      " sim ",
      " quero ajuda ",
      " preciso de ajuda ",
      " suporte ",
      " atendente ",
      " falar com humano ",
      " falar com atendente ",
      " menu ",
      " mais uma coisa ",
      " tem mais uma ",
      " tenho outra ",
      " outra duvida ",
      " outra dúvida ",
      " duvida ",
      " dúvida ",
      " ajuda ",
      " pode me ajudar ",
      " mais ajuda ",
    ].some((k) => t.includes(k)) || t.trim() === "1"
  );
}

/**
 * Política desejada:
 * - Se o usuário NÃO for explícito pedindo ajuda => encerrar educadamente.
 * - Só continua se wantsMoreHelp() for true.
 */
export function shouldEndAfterMoreHelpReply(s: string) {
  const t = norm(s);
  // encerra por padrão, a menos que seja explícito que quer ajuda
  return !wantsMoreHelp(t);
}

// ===============================================================

export function isYes(s: string) {
  const t = norm(` ${s} `);
  return (
    [
      "sim",
      "isso",
      "correto",
      "está certo",
      "ta certo",
      "ok",
      "pode",
      "certo",
      "AUTORIZO",
    ].some((k) => t.includes(k)) || t.trim() === "1"
  );
}
export function isNo(s: string) {
  const t = norm(` ${s} `);
  return (
    [
      "nao",
      "não",
      "incorreto",
      "errado",
      "corrigir",
      "corrigir cpf",
      "trocar cpf",
      "NÃO AUTORIZO",
      "NAO AUTORIZO",
      "nao autorizo",
      "não autorizo",
      "NÃO",
    ].some((k) => t.includes(k)) || t.trim() === "2"
  );
}

export function isFixCPF(s: string) {
  const t = norm(` ${s} `);
  return (
    [
      " corrigir ",
      " corrigir cpf ",
      " errei ",
      " errado ",
      " trocar cpf ",
      " alterar cpf ",
      " arrumar cpf ",
      " ajustar cpf ",
    ].some((k) => t.includes(k)) || t.trim() === "1"
  );
}

export function isCreateAccount(s: string) {
  const t = norm(` ${s} `);
  return (
    [
      " cadastro ",
      " cadastrar ",
      " criar conta ",
      " fazer conta ",
      " registrar ",
      " fazer cadastro ",
      " novo cadastro ",
    ].some((k) => t.includes(k)) || t.trim() === "2"
  );
}

/** pega 11 dígitos do texto se existir (para aceitar o novo CPF escrito livremente) */
export function extractCPF(s: string) {
  const d = (s || "").replace(/\D/g, "");
  return d.length === 11 ? d : "";
}

export function wantsMenu(s: string) {
  const t = norm(s);
  return (
    t.includes("menu") ||
    t.includes("voltar") ||
    t.includes("inicio") ||
    t.includes("início")
  );
}

export function wantsHuman(s: string) {
  const t = norm(s);
  return (
    t.includes("atendente") || t.includes("humano") || t.includes("suporte")
  );
}

export const onlyDigits = (s: string) => (s || "").replace(/\D/g, "");
export const toISODate = (s: string) => {
  const t = s.trim();
  const m1 = t.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (m1) {
    const [_, d, mo, y] = m1;
    return `${y}-${mo}-${d}`;
  }
  const m2 = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return t;
  return "";
};

export async function fetchJSON(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function ensureSession(key: string, sessions: Map<string, Session>) {
  if (!sessions.has(key))
    sessions.set(key, { started: false, step: "idle", pending: {} });
  return sessions.get(key)!;
}

export function formatISOtoBR(iso: string) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

export function formatCPF(cpf: string) {
  const d = onlyDigits(cpf).padStart(11, "0").slice(-11);
  return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

export function parseBrDateTime(dateBr: string, timeBr: string) {
  const [d, m, y] = dateBr.split("/").map((s) => Number(s));
  const [hh, mm] = (timeBr || "00:00").split(":").map((s) => Number(s));
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
}

export function daysDiffFromNow(d: Date) {
  const now = new Date();
  const ms = now.getTime() - d.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

export const friendly = async (text: string) => {
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content:
            "Reescreva a mensagem para WhatsApp de forma simpática, natural e objetiva. Evite soar robótico. Não precisa adicionar saudações, se não tiver, e evite repetir informações desnecessárias.",
        },
        { role: "user", content: text },
      ],
    });
    return r.choices[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
};

export function clearEventContext(
  sess: Session,
  opts?: { keepDesired?: boolean }
) {
  if (sess.event) delete (sess as any).event;

  if ((sess as any).pending) {
    delete (sess as any).pending.eventos;
    delete (sess as any).pending.categoryOptions;
    delete (sess as any).pending.tshirtMap;
    delete (sess as any).pending.cancelMap;
    delete (sess as any).pending.cancelRef;

    if (!opts?.keepDesired) {
      delete (sess as any).pending.desiredIssue;
    }
  }
}

// Compare phone numbers more flexibly: exact match, suffix match (handles missing/extra '9'),
// or matching the last N digits (N up to 9) to tolerate country/area code or formatting differences.
export function phonesMatch(a: string, b: string) {
  const A = onlyDigits(a || "");
  const B = onlyDigits(b || "");
  if (!A || !B) return false;
  if (A === B) return true;
  if (A.endsWith(B) || B.endsWith(A)) return true;
  const n = Math.min(9, A.length, B.length);
  if (A.slice(-n) === B.slice(-n)) return true;

  const correct = (s: string) => (s.length > 4 ? "9" + s.slice(4) : s);

  const CA = correct(A);
  const CB = correct(B);

  if (CA === B || CB === A) return true;
  if (CA === CB) return true;

  const n2 = Math.min(9, CA.length, B.length);
  if (CA.slice(-n2) === B.slice(-n2)) return true;
  const n3 = Math.min(9, CB.length, A.length);
  if (CB.slice(-n3) === A.slice(-n3)) return true;

  return false;
}

/** =========================
 *   Helpers locais
 *  ========================= */
export function chooseIndexByText<T>(
  queryRaw: string,
  list: T[],
  getLabel: (item: T) => string
): number {
  const query = norm(queryRaw);
  if (!query || !list?.length) return -1;
  const qTokens = query.split(/\s+/).filter(Boolean);
  let best = -1;
  let bestScore = 0;
  list.forEach((item, idx) => {
    const label = norm(getLabel(item));
    const lTokens = label.split(/\s+/).filter(Boolean);
    const hits = qTokens.filter((t) => lTokens.includes(t)).length;
    const score = hits / Math.max(3, lTokens.length);
    if (score > bestScore) {
      best = idx;
      bestScore = score;
    }
  });
  return bestScore > 0 ? best : -1;
}

export function genToken() {
  // Gera um número aleatório de 0000 a 9999 (sempre 4 dígitos)
  return Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
}

// Normaliza só dígitos do número
export function digitsPhone(s: string) {
  return (s || "").replace(/\D/g, "");
}
