import { Session } from "../type";
import {
  fetchJSON,
  digitsPhone,
  phonesMatch,
  friendly,
  isNo,
} from "../helpers";
import { sendText } from "../wa";
import { askCPF } from "./cpf";
import { askEvent } from "./events";

/** =========================
 *   Fluxo TRANSFER — helpers
 *  ========================= */

export type TransferAuth = {
  token: string;
  oldPhone: string; // número do titular atual (E.164)
  requesterPhone: string; // número de quem pediu (pode ser o próprio titular)
  oldUserId: number;
  newUserId: number;
  eventId: string;
  eventTitle: string;
  categoryId: string;
  categoryTitle: string;
  expiresAt: number;
};

export const pendingAuth = new Map<string, TransferAuth>();

/**
 * Efetiva a troca no backend.
 * Ajuste o endpoint/contrato conforme o seu backend.
 */
export async function performTransferOwnership(params: {
  eventID: string;
  oldUserID: number;
  newUserID: number;
  token?: string; // opcional quando self-confirm
}) {
  const base = process.env.URL || process.env.API || "";
  // Exemplo com GET (compatível com base já usada no projeto). Troque para POST se preferir.
  const url =
    `${base}/api/transfer_ownership.php` +
    `?eventID=${encodeURIComponent(params.eventID)}` +
    `&oldUserID=${encodeURIComponent(String(params.oldUserID))}` +
    `&newUserID=${encodeURIComponent(String(params.newUserID))}` +
    (params.token ? `&token=${encodeURIComponent(params.token)}` : "");
  return fetchJSON(url);
}

/**
 * Intercepta mensagens do WHATSAPP que sejam resposta de autorização:
 * Formato aceito: "ABC123 1" (autoriza) ou "ABC123 2" (nega)
 * Retorna true se tratou/consumiu a mensagem.
 */
export async function tryResolveAuthorizationGlobal(
  from: string,
  text: string
) {
  // aceita "1234 1", "1234 2" ou apenas "1234" (interpreta como autorização)
  const m = (text || "").trim().match(/^(\d{4})(?:\s+([12]))?$/);
  if (!m) return false;
  const [, token, ans] = m;
  // se a resposta não foi enviada junto com o token, considerar como autorização (1)

  const auth = pendingAuth.get(token);
  if (!auth) return false;

  const fromDigits = digitsPhone(from);

  if (!phonesMatch(fromDigits, digitsPhone(auth.oldPhone))) {
    // Token válido, mas outro número — ignorar
    return false;
  }

  // Expirado?
  if (Date.now() > auth.expiresAt) {
    pendingAuth.delete(token);
    await sendText(
      from,
      await friendly("Este token expirou. Solicite novamente.")
    );
    await sendText(
      auth.requesterPhone,
      await friendly(
        "A autorização expirou. Você pode solicitar novamente a transferência."
      )
    );
    return true;
  }

  // Negado
  if (ans === "2" || isNo(ans)) {
    pendingAuth.delete(token);
    await sendText(from, await friendly("Troca de titularidade *negada*."));
    await sendText(
      auth.requesterPhone,
      await friendly("O titular *negou* a troca de titularidade.")
    );
    return true;
  }

  // Autorizado — efetiva no backend
  try {
    await performTransferOwnership({
      eventID: auth.eventId,
      oldUserID: auth.oldUserId,
      newUserID: auth.newUserId,
    });

    pendingAuth.delete(token);
    await sendText(
      from,
      await friendly("Autorizado. Efetivei a troca de titularidade ✅")
    );
    await sendText(
      auth.requesterPhone,
      await friendly("Prontinho! A troca de titularidade foi concluída ✅")
    );
  } catch (e: any) {
    pendingAuth.delete(token);
    await sendText(
      from,
      await friendly("Não consegui efetivar a troca agora.")
    );
    await sendText(
      auth.requesterPhone,
      await friendly(
        "Falha ao efetivar a troca agora. Tente novamente em alguns instantes."
      )
    );
  }
  return true;
}

/**
 * Inicia o fluxo de transferência:
 * - Se faltam dados do usuário/evento, coleta.
 * - Lista categorias.
 */
export async function startTransferFlow(to: string, sess: Session) {
  if (!sess.user?.id) {
    await sendText(
      to,
      await friendly("Antes, preciso confirmar seu CPF/cadastro.")
    );
    await askCPF(to, sess);
    return;
  }
  if (!sess.event?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_transfer",
    };
    await askEvent(to, sess);
    return;
  }

  await sendText(
    to,
    await friendly("Agora, informe o **CPF do novo titular** (apenas números).")
  );
  (sess as any).step = "awaiting_transfer_cpf";
  return;
}
