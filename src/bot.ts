import type { Message } from "whatsapp-web.js";
import { sendText } from "./wa";
import { Session } from "./type";
import {
  norm,
  ensureSession,
  friendly,
  aiSelectFromList,
  isYes,
  isNo,
  isGoMenu,
  isSwitchEvent,
  extractCPF,
  isFixCPF,
  isCreateAccount,
  clearEventContext,
} from "./helpers";

import { sessions } from "./state/sessions";

import { askIssue, greetFoundUser } from "./flows/menu";
import {
  askCPF,
  askCPFVerify,
  confirmOrCorrectCPFFlow,
  confirmKnownCPF,
} from "./flows/cpf";
import { askEvent } from "./flows/events";
import {
  askCategoryOptions,
  applyCategoryChange,
  handleCategoryFreeText,
} from "./flows/category";
import {
  askTshirtOptions,
  applyTshirtChange,
  matchTshirtByText,
} from "./flows/tshirt";
import { askTeamName, confirmTeamName, applyTeamChange } from "./flows/team";
import { askCancelOptions, confirmCancel, applyCancel } from "./flows/cancel";
import {
  startForgotPassword,
  handleEmailConfirm,
  handleEmailVerification,
  handleBirthdateConfirm,
  handleBirthdateVerification,
} from "./flows/forgot";

/** =========================
 *   Gatilho para iniciar
 *  ========================= */
const TRIGGER_PHRASE = (process.env.TRIGGER_PHRASE || "Olá Bro").trim();
const triggerNorm = norm(TRIGGER_PHRASE);

/** =========================
 *   Handler principal
 *  ========================= */
export async function handleMessage(msg: Message) {
  const text = msg.body?.trim() || "";
  const from = msg.from;
  const phoneE164 = from.replace(/[^0-9]/g, "");
  const sess = ensureSession(phoneE164, sessions);

  if (norm(text) === "fim") {
    sessions.set(phoneE164, { started: false, step: "idle", pending: {} });
    await sendText(
      from,
      'Sessão encerrada. Envie a frase-gatilho "Olá Bro" para iniciar novamente.'
    );
    return;
  }

  if (!sess.started) {
    const incoming = norm(text);
    if (incoming.includes(triggerNorm)) {
      sess.started = true;
      await sendText(
        from,
        await friendly(
          "Fala, atleta! 🏃‍♂️\nEu sou o BRO, assistente da Sportbro! 💙\nBora começar seu atendimento? Me conta como posso te ajudar. 🙂"
        )
      );
      if (sess.user?.cpf) await askCPFVerify(from, sess);
      else await askCPF(from, sess);
    }
    return;
  }

  switch ((sess as any).step) {
    case "awaiting_event": {
      const lista = ((sess as any).pending?.eventos as any[]) || [];
      const raw = (text || "").trim();

      // número
      const asNum = Number(raw);
      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= lista.length) {
        const ev = lista[asNum - 1];
        sess.event = {
          id: String(ev.id),
          title: String(ev.titulo || "Evento selecionado"),
        };
      } else {
        // IA por texto
        const idx = await aiSelectFromList(raw, lista, (ev: any) => {
          const cat = ev.categoria ? ` ${ev.categoria}` : "";
          return `${ev.titulo}${cat}`;
        });
        if (idx >= 0) {
          const ev = lista[idx];
          sess.event = {
            id: String(ev.id),
            title: String(ev.titulo || "Evento selecionado"),
          };
        } else {
          await sendText(
            from,
            await friendly(
              "Não encontrei. Pode digitar parte do nome do evento ou escolher pelo número da lista?"
            )
          );
          await askEvent(from, sess);
          return;
        }
      }

      await sendText(
        from,
        await friendly(`Perfeito! Anotei o evento **${sess.event.title}**.`)
      );

      const desired = (sess as any).pending?.desiredIssue as string | undefined;
      (sess as any).pending.desiredIssue = undefined;

      if (desired === "iss_cat") return askCategoryOptions(from, sess);
      if (desired === "iss_size") return askTshirtOptions(from, sess);
      if (desired === "iss_team") return askTeamName(from, sess);
      if (desired === "iss_cancel") return askCancelOptions(from, sess);

      return askIssue(from, sess);
    }

    case "awaiting_issue": {
      const option = norm(text);
      const directMap: Record<string, string> = {
        "1": "iss_pwd",
        "2": "iss_cat",
        "3": "iss_size",
        "4": "iss_team",
        "5": "iss_cancel",
        "6": "choose_event",
        senha: "iss_pwd",
        categoria: "iss_cat",
        tamanho: "iss_size",
        "tamanho camiseta": "iss_size",
        equipe: "iss_team",
        cancelar: "iss_cancel",
        "cancelar inscricao": "iss_cancel",
        "cancelar inscrição": "iss_cancel",
        evento: "choose_event",
      };

      let selected =
        directMap[option] ||
        (await (await import("./helpers")).classifyIssue(text));
      if (!selected || selected === "unknown") {
        await sendText(
          from,
          await friendly(
            "Pode me dizer em poucas palavras o que você precisa? Ex.: trocar categoria, cancelar inscrição, recuperar senha."
          )
        );
        await askIssue(from, sess);
        return;
      }

      switch (selected) {
        case "iss_pwd":
          return startForgotPassword(from, sess);

        case "iss_cat":
          if (!sess.event?.id) {
            (sess as any).pending = {
              ...((sess as any).pending || {}),
              desiredIssue: "iss_cat",
            };
            clearEventContext(sess, { keepDesired: true });
            await askEvent(from, sess);
            return;
          }
          return askCategoryOptions(from, sess);

        case "iss_size":
          if (!sess.event?.id) {
            (sess as any).pending = {
              ...((sess as any).pending || {}),
              desiredIssue: "iss_size",
            };
            clearEventContext(sess, { keepDesired: true });
            await askEvent(from, sess);
            return;
          }
          return askTshirtOptions(from, sess);

        case "iss_team":
          if (!sess.event?.id) {
            (sess as any).pending = {
              ...((sess as any).pending || {}),
              desiredIssue: "iss_team",
            };
            clearEventContext(sess, { keepDesired: true });
            await askEvent(from, sess);
            return;
          }
          return askTeamName(from, sess);

        case "iss_cancel":
          if (!sess.event?.id) {
            (sess as any).pending = {
              ...((sess as any).pending || {}),
              desiredIssue: "iss_cancel",
            };
            clearEventContext(sess, { keepDesired: true });
            await sendText(
              from,
              await friendly(
                "Para cancelar, me diga o evento. Pode digitar o nome."
              )
            );
            await askEvent(from, sess);
            return;
          }
          return askCancelOptions(from, sess);

        case "choose_event":
          return askEvent(from, sess);
      }
      return;
    }

    case "awaiting_no_category_action": {
      const ans = norm(text);
      if (ans === "1" || ans.includes("atendente")) {
        if ((sess as any).pending) {
          delete (sess as any).pending.categoryOptions;
          delete (sess as any).pending.desiredIssue;
        }
        await sendText(
          from,
          await friendly(
            "Certo! Vou acionar um atendente humano e repassar sua solicitação. Pode me enviar mais detalhes aqui que eu encaminho. 🙂"
          )
        );
        (sess as any).step = "idle";
        return;
      }
      if (ans === "2" || isGoMenu(text)) {
        if ((sess as any).pending) {
          delete (sess as any).pending.categoryOptions;
          delete (sess as any).pending.desiredIssue;
        }
        clearEventContext(sess);
        await askIssue(from, sess);
        return;
      }
      await sendText(
        from,
        await friendly("Quer Falar com atendente ou voltar ao *Menu*?")
      );
      return;
    }

    case "awaiting_no_tshirt_action": {
      const ans = norm(text);
      if (ans === "1" || ans.includes("atendente")) {
        if ((sess as any).pending) {
          delete (sess as any).pending.tshirtMap;
          delete (sess as any).pending.desiredIssue;
        }
        await sendText(
          from,
          await friendly(
            "Certo! Vou acionar um atendente humano e repassar sua solicitação. Pode me enviar mais detalhes aqui que eu encaminho. 🙂"
          )
        );
        (sess as any).step = "idle";
        return;
      }
      if (ans === "2" || isGoMenu(text)) {
        if ((sess as any).pending) {
          delete (sess as any).pending.tshirtMap;
          delete (sess as any).pending.desiredIssue;
        }
        clearEventContext(sess);
        await askIssue(from, sess);
        return;
      }
      await sendText(
        from,
        await friendly("Quer Falar com atendente ou voltar ao *Menu*?")
      );
      return;
    }

    case "awaiting_no_cancel_action": {
      const ans = norm(text);
      if (ans === "1" || ans.includes("atendente")) {
        if ((sess as any).pending) {
          delete (sess as any).pending.cancelMap;
          delete (sess as any).pending.cancelRef;
          delete (sess as any).pending.desiredIssue;
        }
        await sendText(
          from,
          await friendly(
            "Certo! Vou acionar um atendente e repassar sua solicitação."
          )
        );
        (sess as any).step = "idle";
        return;
      }
      if (ans === "2" || isGoMenu(text)) {
        if ((sess as any).pending) {
          delete (sess as any).pending.cancelMap;
          delete (sess as any).pending.cancelRef;
          delete (sess as any).pending.desiredIssue;
        }
        clearEventContext(sess);
        await askIssue(from, sess);
        return;
      }
      await sendText(
        from,
        await friendly("Quer *Falar com atendente* ou voltar ao *Menu*?")
      );
      return;
    }

    case "awaiting_cancel_redirect": {
      const ans = norm(text);
      if (ans === "1" || ans.includes("evento")) {
        (sess as any).pending.desiredIssue = "iss_cancel";
        await askEvent(from, sess);
        return;
      }
      if (ans === "2" || ans.includes("atendente")) {
        (sess as any).step = "idle";
        await sendText(
          from,
          await friendly(
            "Ok! Vou acionar um atendente e repassar sua solicitação."
          )
        );
        return;
      }
      if (ans === "3" || isGoMenu(text)) {
        clearEventContext(sess);
        await askIssue(from, sess);
        return;
      }
      await sendText(
        from,
        await friendly(
          "Responda com 1 (Trocar de evento), 2 (Falar com atendente) ou 3 (Voltar ao menu)."
        )
      );
      return;
    }

    case "awaiting_category_choice": {
      const lista = ((sess as any).pending?.categoryOptions as any[]) || [];
      const raw = (text || "").trim();
      const num = Number(raw);

      if (isSwitchEvent(raw)) {
        (sess as any).pending.desiredIssue = "iss_cat";
        clearEventContext(sess, { keepDesired: true });
        await askEvent(from, sess);
        return;
      }

      if (Number.isInteger(num) && num >= 1 && num <= lista.length) {
        const chosen = lista[num - 1];
        await applyCategoryChange(from, sess, String(chosen.id));
        return;
      }

      const pickIndex = await handleCategoryFreeText(raw, lista);
      if (pickIndex >= 0) {
        const chosen = lista[pickIndex];
        await applyCategoryChange(from, sess, String(chosen.id));
        return;
      }

      await sendText(
        from,
        await friendly(
          "Não consegui entender. Pode repetir? Você pode digitar parte do nome da categoria."
        )
      );
      await askCategoryOptions(from, sess);
      return;
    }

    case "awaiting_tshirt_choice": {
      const raw = (text || "").trim();
      if (isSwitchEvent(raw)) {
        (sess as any).pending.desiredIssue = "iss_size";
        clearEventContext(sess, { keepDesired: true });
        await askEvent(from, sess);
        return;
      }

      const map: Record<number, { tamanho: string; label: string }> =
        ((sess as any).pending?.tshirtMap as any) || {};

      const n = Number(raw);
      if (Number.isInteger(n) && map[n]) {
        await applyTshirtChange(from, sess, map[n].tamanho);
        return;
      }

      const { list, buildText } = matchTshirtByText(raw, map);

      // IA
      const aiIdx = await aiSelectFromList(raw, list, buildText);
      if (aiIdx >= 0) {
        await applyTshirtChange(from, sess, list[aiIdx].tamanho);
        return;
      }

      // fallback token
      const q = norm(raw);
      const tokens = q.split(/\s+/).filter(Boolean);
      const pick = list.find((s) => {
        const hay = buildText(s);
        return tokens.every((tk) => hay.includes(tk));
      });
      if (pick) {
        await applyTshirtChange(from, sess, pick.tamanho);
        return;
      }

      // fallback canônico
      const sizeOnly = q.replace(/\s+/g, "");
      const pick2 = list.find((s) => {
        const tCanon = norm(s.tamanho).replace(/\s+/g, "");
        const lCanon = norm(s.label).replace(/\s+/g, "");
        return tCanon === sizeOnly || lCanon.includes(sizeOnly);
      });
      if (pick2) {
        await applyTshirtChange(from, sess, pick2.tamanho);
        return;
      }

      await sendText(
        from,
        await friendly(
          'Não consegui entender. Você pode digitar parte do nome, por exemplo: "gg", "baby look p", "infantil m".'
        )
      );
      await askTshirtOptions(from, sess);
      return;
    }

    case "awaiting_cancel_choice": {
      const raw = (text || "").trim();
      if (isSwitchEvent(raw)) {
        (sess as any).pending.desiredIssue = "iss_cancel";
        clearEventContext(sess, { keepDesired: true });
        await askEvent(from, sess);
        return;
      }
      const map: Record<
        number,
        { reference: string; titulo: string; data: string; hora: string }
      > = ((sess as any).pending?.cancelMap as any) || {};
      const n = Number(raw);
      if (Number.isInteger(n) && map[n]) {
        await confirmCancel(from, sess, map[n].reference);
        return;
      }
      await sendText(
        from,
        await friendly("Não consegui entender. Pode repetir?")
      );
      await askCancelOptions(from, sess);
      return;
    }

    case "awaiting_cancel_confirm": {
      const ans = norm(text);
      if (isYes(ans)) {
        await applyCancel(from, sess);
        return;
      }
      if (isNo(ans)) {
        if ((sess as any).pending) {
          delete (sess as any).pending.cancelRef;
          delete (sess as any).pending.cancelMap;
        }
        await sendText(
          from,
          await friendly("Sem problemas! Não realizei o cancelamento.")
        );
        await askIssue(from, sess);
        return;
      }
      await sendText(
        from,
        await friendly("Não consegui entender, pode repetir?")
      );
      return;
    }

    case "awaiting_cancel_retry": {
      const ans = norm(text);
      if (ans === "1" || ans.includes("tentar")) {
        await askCancelOptions(from, sess);
        return;
      }
      if (ans === "2" || ans.includes("atendente")) {
        (sess as any).step = "idle";
        await sendText(
          from,
          await friendly(
            "Certo! Vou acionar um atendente e repassar sua solicitação."
          )
        );
        return;
      }
      if (ans === "3" || isGoMenu(text)) {
        clearEventContext(sess);
        await askIssue(from, sess);
        return;
      }
      await sendText(
        from,
        await friendly(
          "Responda com 1 (Tentar novamente), 2 (Falar com atendente) ou 3 (Voltar ao menu)."
        )
      );
      return;
    }

    case "awaiting_team_name": {
      const raw = (text || "").trim();
      if (isSwitchEvent(raw)) {
        (sess as any).pending.desiredIssue = "iss_team";
        clearEventContext(sess, { keepDesired: true });
        await askEvent(from, sess);
        return;
      }
      await confirmTeamName(from, sess, raw);
      return;
    }

    case "awaiting_team_confirm": {
      if (isYes(text)) return applyTeamChange(from, sess);
      if (isNo(text)) return askTeamName(from, sess);
      await sendText(from, await friendly("Não entendi, pode repetir?"));
      return;
    }

    case "awaiting_cpf_verify": {
      await confirmKnownCPF(from, sess, text, {
        extractCPF,
        isYes,
        isNo,
        friendly,
      });
      return;
    }

    case "awaiting_cpf": {
      const result = await confirmOrCorrectCPFFlow(from, sess, text, {
        extractCPF,
        isFixCPF,
        isCreateAccount,
        friendly,
      });
      if (!result.done) return;
      return;
    }

    case "awaiting_email_confirm":
      await handleEmailConfirm(from, sess, text);
      return;
    case "awaiting_email_verification":
      await handleEmailVerification(from, sess, text);
      return;
    case "awaiting_birthdate_confirm":
      await handleBirthdateConfirm(from, sess, text);
      return;
    case "awaiting_birthdate_verification":
      await handleBirthdateVerification(from, sess, text);
      return;

    case "awaiting_more_help": {
      const ans = norm(text);
      if (isYes(ans)) return askIssue(from, sess);
      if (isNo(ans)) {
        await sendText(
          from,
          await friendly(
            "Perfeito! Qualquer coisa é só chamar. Tenha um ótimo dia! 🙏"
          )
        );
        sessions.set(phoneE164, { started: false, step: "idle", pending: {} });
        return;
      }
      await sendText(
        from,
        await friendly("Não consegui entender, pode repetir?")
      );
      return;
    }

    case "idle":
    default:
      break;
  }

  if (sess.started && !sess.event?.id && (sess as any).pending?.desiredIssue) {
    await askEvent(from, sess);
    return;
  }

  await sendText(
    from,
    await friendly(
      'Estou aqui para ajudar! Você pode me dizer o que precisa ou responder ao menu. Se preferir, digite "fim" para reiniciar.'
    )
  );
}
