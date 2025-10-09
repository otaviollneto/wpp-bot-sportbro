import OpenAI from "openai";
import { Session } from "./type";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
    ]);
    return allowed.has(key) ? (key as any) : "unknown";
  } catch {
    // Fallback por palavras‑chave
    const t = norm(text);
    if (t.includes("senha")) return "iss_pwd";
    if (t.includes("categoria")) return "iss_cat";
    if (t.includes("camiseta") || t.includes("tamanho")) return "iss_size";
    if (t.includes("equipe")) return "iss_team";
    if (t.includes("cancel")) return "iss_cancel";
    if (t.includes("evento")) return "choose_event";
    return "unknown";
  }
}

export function isSwitchEvent(s: string) {
  const t = norm(` ${s} `);
  // palavras e variações comuns
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
  // aceita também o atalho "0"
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

// 2) Selecionar item por texto (ex.: evento pelo título). Usa LLM + fallback fuzzy local.
export async function aiSelectFromList<T>(
  userText: string,
  items: T[],
  getLabel: (item: T) => string
): Promise<number> {
  if (!items?.length) return -1;

  // Monte uma lista curta de labels para o LLM decidir
  const labels = items.map((x, i) => `${i + 1}. ${getLabel(x)}`).join("\n");
  const prompt = `
Você deve escolher o ÍNDICE (1..N) do item que melhor corresponde ao pedido do usuário, ou 0 se nenhum.
Responda APENAS com um número inteiro.
Lista:
${labels}

Pedido do usuário: "${userText}"
`;

  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Responda apenas com um número inteiro (0..N). Nenhum outro texto.",
        },
        { role: "user", content: prompt },
      ],
    });
    const raw = (r.choices[0]?.message?.content || "").trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
  } catch {
    // cai no fuzzy
  }

  // Fallback: fuzzy local (includes + escore simples)
  const q = norm(userText);
  let best = -1,
    bestScore = 0;
  items.forEach((it, idx) => {
    const lab = norm(getLabel(it));
    // score simples: presença + tamanho da interseção
    const score = lab.includes(q) ? q.length / Math.max(10, lab.length) : 0;
    if (score > bestScore) {
      best = idx;
      bestScore = score;
    }
  });
  return best; // -1 = nada bom o suficiente
}

// 3) Yes/No livres
export function isYes(s: string) {
  const t = norm(` ${s} `);
  return (
    ["sim", "isso", "correto", "está certo", "ta certo", "ok", "pode"].some(
      (k) => t.includes(k)
    ) || t.trim() === "1"
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

// 4) Voltar/menu/atendente por texto
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
  // aceita dd/mm/aaaa, dd-mm-aaaa, aaaa-mm-dd
  const t = s.trim();
  const m1 = t.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (m1) {
    const [_, d, mo, y] = m1;
    return `${y}-${mo}-${d}`;
  }
  const m2 = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return t;
  return ""; // inválida
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
  // dateBr: dd/mm/yyyy, timeBr: HH:MM
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
