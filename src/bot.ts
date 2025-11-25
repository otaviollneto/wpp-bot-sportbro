import type { Message } from "whatsapp-web.js";
import { applyCancel, askCancelOptions, confirmCancel } from "./flows/cancel";
import {
  applyCategoryChange,
  askCategoryOptions,
  handleCategoryFreeText,
} from "./flows/category";
import {
  askCPF,
  askCPFVerify,
  confirmKnownCPF,
  confirmOrCorrectCPFFlow,
} from "./flows/cpf";
import { askEvent } from "./flows/events";
import {
  handleBirthdateConfirm,
  handleBirthdateVerification,
  handleEmailConfirm,
  handleEmailVerification,
  startForgotPassword,
} from "./flows/forgot";
import { askIssue } from "./flows/menu";
import { applyTeamChange, askTeamName, confirmTeamName } from "./flows/team";
import {
  applyTshirtChange,
  askTshirtOptions,
  matchTshirtByText,
} from "./flows/tshirt";
import {
  chooseIndexByText,
  clearEventContext,
  digitsPhone,
  END_TRIGGERS,
  ensureSession,
  EXTRA_TRIGGERS,
  extractCPF,
  fetchJSON,
  formatCPF,
  friendly,
  genToken,
  isCreateAccount,
  isFixCPF,
  isGoMenu,
  isNo,
  isPoliteEnd,
  isSwitchEvent,
  isYes,
  norm,
  phonesMatch,
  shouldEndAfterMoreHelpReply,
  TRIGGER_PHRASE,
  wantsMoreHelp,
} from "./helpers";
import { sessions } from "./state/sessions";
import { sendText } from "./wa";
import {
  tryResolveAuthorizationGlobal,
  startTransferFlow,
  TransferAuth,
  pendingAuth,
  performTransferOwnership,
} from "./flows/transfer";
import { handleFaqFlow, sendFaqOrganizerLink, startFaqFlow } from "./flows/faq";

const triggerNorm = norm(TRIGGER_PHRASE);

/** =========================
 *   Handler principal
 *  ========================= */
export async function handleMessage(msg: Message) {
  const text = msg.body?.trim() || "";
  const from = msg.from;
  const phoneE164 = digitsPhone(from);
  const sess = ensureSession(phoneE164, sessions);

  // 1) Primeiro: intercepta possíveis respostas de autorização global (TOKEN 1/2)
  const handledAuth = await tryResolveAuthorizationGlobal(from, text);
  if (handledAuth) return;

  // 2) Comando rápido para finalizar sessão
  {
    const incoming = norm(text);

    const isEndTrigger = END_TRIGGERS.includes(incoming);

    if (isEndTrigger) {
      sessions.set(phoneE164, { started: false, step: "idle", pending: {} });
      await sendText(
        from,
        await friendly(
          'Sessão encerrada. Envie "Olá Bro" ou "Iniciar atendimento BRO" para começar de novo.'
        )
      );
      return;
    }
  }

  // 3) Boot
  if (!sess.started) {
    const incoming = norm(text);

    const isTrigger =
      (!!triggerNorm && incoming.includes(triggerNorm)) ||
      EXTRA_TRIGGERS.some((t) => incoming.includes(t));

    if (isTrigger) {
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
    /** =========================
     *  Seleção de evento (comum)
     *  ========================= */
    case "awaiting_event": {
      const lista = ((sess as any).pending?.eventos as any[]) || [];
      const raw = (text || "").trim();
      const asNum = Number(raw);

      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= lista.length) {
        const ev = lista[asNum - 1];
        sess.event = {
          id: String(ev.id),
          title: String(ev.titulo || "Evento selecionado"),
        };
      } else {
        const idx = chooseIndexByText(raw, lista, (ev: any) => {
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
              "Não encontrei. Pode digitar parte do nome do evento ou escolher pelo número?"
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
      if (desired === "iss_transfer") return startTransferFlow(from, sess);

      return askIssue(from, sess);
    }

    /** =========================
     *  Menu principal
     *  ========================= */
    case "awaiting_issue": {
      const option = norm(text);
      const directMap: Record<string, string> = {
        "1": "iss_pwd",
        "2": "iss_cat",
        "3": "iss_size",
        "4": "iss_team",
        "5": "iss_cancel",
        "6": "iss_transfer",
        "7": "iss_faq",
        senha: "iss_pwd",
        categoria: "iss_cat",
        tamanho: "iss_size",
        "tamanho camiseta": "iss_size",
        equipe: "iss_team",
        cancelar: "iss_cancel",
        "cancelar inscricao": "iss_cancel",
        "cancelar inscrição": "iss_cancel",
        evento: "choose_event",
        transferir: "iss_transfer",
        transferencia: "iss_transfer",
        transferência: "iss_transfer",
        "transferir titularidade": "iss_transfer",
        "troca de titularidade": "iss_transfer",
        titularidade: "iss_transfer",
        duvidas: "iss_faq",
        dúvidas: "iss_faq",
        "duvidas do evento": "iss_faq",
        "dúvidas do evento": "iss_faq",
      };

      let selected =
        directMap[option] ||
        (await (await import("./helpers"))
          .classifyIssue(text)
          .catch(() => "unknown"));

      if (
        selected === "unknown" &&
        /transfer|titular/i.test(text.normalize("NFD"))
      ) {
        selected = "iss_transfer";
      }

      if (!selected || selected === "unknown") {
        await sendText(
          from,
          await friendly(
            "Pode me dizer em poucas palavras o que você precisa? Ex.: trocar categoria, cancelar inscrição, recuperar senha, transferir titularidade."
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
              await friendly("Para cancelar, me diga o evento.")
            );
            await askEvent(from, sess);
            return;
          }
          return askCancelOptions(from, sess);

        case "iss_transfer":
          if (!sess.event?.id) {
            (sess as any).pending = {
              ...((sess as any).pending || {}),
              desiredIssue: "iss_transfer",
            };
            clearEventContext(sess, { keepDesired: true });
            await sendText(
              from,
              await friendly(
                "Para transferir a titularidade, informe o **evento**."
              )
            );
            await askEvent(from, sess);
            return;
          }
          return startTransferFlow(from, sess);

        case "choose_event":
          return askEvent(from, sess);

        case "iss_faq":
          return startFaqFlow(from, sess);
      }
      return;
    }

    case "awaiting_faq_menu": {
      await handleFaqFlow(from, sess, text);
      return;
    }

    /** =========================
     *  TRANSFER: titular ou não
     *  ========================= */
    case "awaiting_holder_role": {
      const ans = norm(text);

      if (ans === "1" || isYes(ans)) {
        // O solicitante é o próprio titular
        (sess as any).pending = {
          ...((sess as any).pending || {}),
          transfer: {
            ...((sess as any).pending?.transfer || {}),
            oldUser: {
              id: Number((sess as any).user?.id || (sess as any).user?.ID),
              name: String(
                (sess as any).user?.nome ||
                  (sess as any).user?.name ||
                  (sess as any).user?.Nome ||
                  ""
              ),
              phone: String(
                (sess as any).user?.telefone ||
                  (sess as any).user?.phone ||
                  (sess as any).user?.celular ||
                  ""
              ),
            },
          },
        };

        await sendText(
          from,
          await friendly(
            "Perfeito! Agora me informe o **CPF do novo titular** (apenas números)."
          )
        );
        (sess as any).step = "awaiting_transfer_cpf";
        return;
      }

      if (ans === "2" || isNo(ans)) {
        await sendText(
          from,
          await friendly(
            "Sem problemas! Me informe o **CPF do titular atual da inscrição** (11 dígitos, apenas números)."
          )
        );
        (sess as any).step = "awaiting_holder_cpf";
        return;
      }

      await sendText(
        from,
        await friendly(
          "Você é o titular atual da inscrição?\n1. Sim, sou o titular.\n2. Não, estou pedindo em nome do titular."
        )
      );
      return;
    }

    /** =========================
     *  TRANSFER: CPF do titular atual
     *  ========================= */
    case "awaiting_holder_cpf": {
      const cpf = extractCPF(text);
      if (!cpf) {
        await sendText(
          from,
          await friendly(
            "CPF inválido. Me envie o CPF do titular atual com 11 dígitos (apenas números)."
          )
        );
        return;
      }

      try {
        const data = await fetchJSON(
          `${
            process.env.URL || process.env.API
          }/api/user_data.php?document=${cpf}`
        );
        const user = data?.data;
        if (!user?.id) {
          await sendText(
            from,
            await friendly(
              "Não encontrei cadastro para esse CPF como titular. Peça para o titular se cadastrar no site e me avise."
            )
          );
          (sess as any).step = "awaiting_more_help";
          return;
        }

        (sess as any).pending = {
          ...((sess as any).pending || {}),
          transfer: {
            ...((sess as any).pending?.transfer || {}),
            tempOldCPF: cpf,
            tempOldHolder: {
              id: Number(user.id),
              name: String(user.nome || user.name || ""),
              phone: String(user.telefone || user.phone || ""),
            },
          },
        };

        const msg = await friendly(
          `Confirmar titular atual?\nNome: ${String(
            user.nome || user.name || "Não informado"
          )}\nCPF: ${formatCPF(cpf)}\n\n1. Confirmar\n2. Corrigir CPF`
        );
        await sendText(from, msg);
        (sess as any).step = "awaiting_holder_confirm";
      } catch {
        await sendText(
          from,
          await friendly(
            "Tive um problema ao consultar esse CPF. Tente novamente em instantes."
          )
        );
      }
      return;
    }

    /** =========================
     *  TRANSFER: confirmar titular atual
     *  ========================= */
    case "awaiting_holder_confirm": {
      const ans = norm(text);

      if (ans === "2" || isNo(ans)) {
        if ((sess as any).pending?.transfer) {
          delete (sess as any).pending.transfer.tempOldCPF;
          delete (sess as any).pending.transfer.tempOldHolder;
        }
        await sendText(
          from,
          await friendly(
            "Beleza! Me envie novamente o CPF do titular atual (11 dígitos)."
          )
        );
        (sess as any).step = "awaiting_holder_cpf";
        return;
      }

      if (ans === "1" || isYes(ans)) {
        const t = (sess as any).pending?.transfer || {};
        (sess as any).pending.transfer = {
          ...t,
          oldCPF: t.tempOldCPF,
          oldUser: t.tempOldHolder,
        };
        if ((sess as any).pending.transfer) {
          delete (sess as any).pending.transfer.tempOldCPF;
          delete (sess as any).pending.transfer.tempOldHolder;
        }

        await sendText(
          from,
          await friendly(
            "Perfeito! Agora me informe o **CPF do novo titular** (apenas números)."
          )
        );
        (sess as any).step = "awaiting_transfer_cpf";
        return;
      }

      await sendText(
        from,
        await friendly(
          "Responda com 1 para confirmar ou 2 para corrigir o CPF do titular atual."
        )
      );
      return;
    }

    /** =========================
     *  TRANSFER: CPF do novo titular
     *  ========================= */
    case "awaiting_transfer_cpf": {
      const cpf = extractCPF(text);
      if (!cpf) {
        await sendText(
          from,
          await friendly("CPF inválido. Digite 11 dígitos (apenas números).")
        );
        return;
      }
      // Consulta cadastro do novo titular
      try {
        const data = await fetchJSON(
          `${
            process.env.URL || process.env.API
          }/api/user_data.php?document=${cpf}`
        );
        const user = data?.data;
        if (!user?.id) {
          await sendText(
            from,
            await friendly(
              "Não encontrei cadastro para esse CPF. Peça ao **novo titular** que se cadastre no site e me avise."
            )
          );
          (sess as any).step = "awaiting_more_help";
          return;
        }
        (sess as any).pending.transfer = {
          ...((sess as any).pending.transfer || {}),
          recipientCPF: cpf,
          newHolder: {
            id: Number(user.id),
            name: String(user.nome || user.name || ""),
          },
        };

        const msg = await friendly(
          `Confirmar novo titular?\nNome: ${String(
            user.nome || user.name || "Não informado"
          )}\nCPF: ${formatCPF(cpf)}\n\n1. Confirmar\n2. Corrigir CPF`
        );
        await sendText(from, msg);
        (sess as any).step = "awaiting_transfer_confirm";
      } catch {
        await sendText(
          from,
          await friendly("Falha ao buscar o CPF. Tente novamente.")
        );
      }
      return;
    }

    /** =========================
     *  TRANSFER: confirmar novo titular
     *  ========================= */
    case "awaiting_transfer_confirm": {
      const ans = norm(text);
      if (ans === "2" || isNo(ans)) {
        (sess as any).pending.transfer = {
          ...((sess as any).pending.transfer || {}),
          recipientCPF: undefined,
          newHolder: undefined,
        };
        await sendText(
          from,
          await friendly("Informe o **CPF do novo titular** (11 dígitos).")
        );
        (sess as any).step = "awaiting_transfer_cpf";
        return;
      }
      if (!isNo(ans) && !isYes(ans)) {
        await sendText(
          from,
          await friendly("Responda com sim confirmando ou não para corrigir.")
        );
        return;
      }

      const evName = String(sess.event?.title || "evento");
      const catName = String(
        (sess as any).pending?.transfer?.categoryTitle || "-"
      );
      const cpf = String((sess as any).pending?.transfer?.recipientCPF || "");
      const newName = String(
        (sess as any).pending?.transfer?.newHolder?.name || ""
      );

      const transferCtx = (sess as any).pending?.transfer || {};
      const oldUser = transferCtx.oldUser || (sess as any).user || {};

      const oldPhoneProfile = String(
        (oldUser as any)?.phone || (oldUser as any)?.telefone || ""
      ).trim();
      const requesterDigits = digitsPhone(from);
      const profileDigits = digitsPhone(oldPhoneProfile);

      // Se é o próprio titular na conversa, confirma local
      if (phonesMatch(requesterDigits, profileDigits)) {
        await sendText(
          from,
          await friendly(
            `Você é o titular atual desta inscrição.\nConfirma a *troca de titularidade* do **${evName}** (categoria **${catName}**) para ${newName} – CPF ${formatCPF(
              cpf
            )}?\n\nResponda **AUTORIZO** para confirmar, ou **NÃO** para cancelar.`
          )
        );
        (sess as any).step = "awaiting_transfer_self_confirm";
        return;
      }

      // Senão, envia token ao titular atual (telefone do cadastro)
      if (!oldPhoneProfile) {
        await sendText(
          from,
          await friendly(
            "Não encontrei telefone cadastrado do titular atual para autorização. Fale com um atendente."
          )
        );
        (sess as any).step = "awaiting_more_help";
        return;
      }

      const token = genToken();
      const auth: TransferAuth = {
        token,
        oldPhone: oldPhoneProfile,
        requesterPhone: from,
        oldUserId: Number(
          (transferCtx.oldUser && transferCtx.oldUser.id) ||
            (sess as any).user?.id
        ),
        newUserId: Number((sess as any).pending.transfer.newHolder.id),
        eventId: String(sess.event!.id),
        eventTitle: evName,
        categoryId: String((sess as any).pending.transfer.categoryId),
        categoryTitle: catName,
        expiresAt: Date.now() + 30 * 60 * 1000, // 30 min
      };
      pendingAuth.set(token, auth);

      const target = digitsPhone(oldPhoneProfile);
      const toTitularText = await friendly(
        `Confirma a *troca de titularidade* da sua inscrição do evento **${evName}** (categoria **${catName}**) para ${newName} – CPF ${formatCPF(
          cpf
        )}?\n\nResponda com código: *${token}* para autorizar.`
      );

      // Abre sessão do titular aguardando resposta (sem estragar o estado dele, apenas para garantir "started")
      const titularSess = ensureSession(target, sessions);
      titularSess.started = true;

      await sendText(target, toTitularText);
      await sendText(
        from,
        await friendly(
          "Enviei uma mensagem ao titular atual para autorizar. Te aviso aqui assim que ele responder."
        )
      );
      (sess as any).step = "awaiting_transfer_result";
      return;
    }

    /** =========================
     *  TRANSFER: confirmação local (titular = solicitante)
     *  ========================= */
    case "awaiting_transfer_self_confirm": {
      const t = norm(text);

      // Aceita apenas números "1" ou "2"
      if (t === "1" || isYes(t)) {
        try {
          const transferCtx = (sess as any).pending?.transfer || {};
          const oldUserId = Number(
            (transferCtx.oldUser && transferCtx.oldUser.id) ||
              (sess as any).user?.id
          );
          const newUserId = Number(transferCtx.newHolder.id);
          const eventID = String(sess.event!.id);

          await performTransferOwnership({
            eventID,
            oldUserID: oldUserId,
            newUserID: newUserId,
          });

          await sendText(
            from,
            await friendly("Transferência concluída com sucesso! ✅")
          );
          (sess as any).step = "awaiting_more_help";
          await sendText(
            from,
            await friendly("Posso ajudar em mais alguma coisa?")
          );
          return;
        } catch (e: any) {
          await sendText(
            from,
            await friendly(
              `Não consegui concluir a transferência agora.\nMotivo: ${
                e?.message || "erro inesperado"
              }\n\nVocê deseja tentar novamente, falar com um atendente ou voltar ao menu?\n1. Tentar novamente\n2. Falar com atendente\n3. Voltar ao menu`
            )
          );
          (sess as any).step = "awaiting_transfer_retry";
          return;
        }
      }

      if (t === "2" || isNo(t)) {
        (sess as any).pending.transfer = undefined;
        await sendText(
          from,
          await friendly("Sem problemas! Não realizei a transferência.")
        );
        await askIssue(from, sess);
        return;
      }

      // Mensagem de orientação
      await sendText(
        from,
        await friendly(
          "Para confirmar a transferência, responda com **1 (Sim)** ou **2 (Não)**."
        )
      );
      return;
    }

    /** =========================
     *  TRANSFER: retry menu (falha)
     *  ========================= */
    case "awaiting_transfer_retry": {
      const t = norm(text);
      if (t === "1" || t.includes("tentar")) {
        await startTransferFlow(from, sess);
        return;
      }
      if (t === "2" || t.includes("atendente") || t.includes("humano")) {
        (sess as any).step = "idle";
        await sendText(
          from,
          await friendly(
            "Certo! Vou acionar um atendente e repassar sua solicitação."
          )
        );
        return;
      }
      if (t === "3" || isGoMenu(text)) {
        (sess as any).pending.transfer = undefined;
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

    /** =========================
     *  Fluxos existentes
     *  ========================= */
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
            "Certo! Vou acionar um atendente humano e repassar sua solicitação. 🙂"
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
        await friendly("Quer falar com *atendente* ou voltar ao *Menu*?")
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
            "Certo! Vou acionar um atendente humano e repassar sua solicitação. 🙂"
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
        await friendly("Quer falar com *atendente* ou voltar ao *Menu*?")
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
      const q = norm(raw);
      const tokens = q.split(/\s+/).filter(Boolean);
      const pick = list.find((s) => {
        const hay = norm(buildText(s));
        return tokens.every((tk) => hay.includes(tk));
      });
      if (pick) {
        await applyTshirtChange(from, sess, pick.tamanho);
        return;
      }

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
          'Não consegui entender. Exemplos: "gg", "baby look p", "infantil m".'
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

    /** =========================
     *  CPF + Forgot flows
     *  ========================= */
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

    /** =========================
     *  Encerramento padrão
     *  ========================= */
    case "awaiting_more_help": {
      if (wantsMoreHelp(text)) {
        (sess as any).step = "idle";
        await sendText(
          from,
          await friendly("Claro! Diga como posso ajudar ou digite *menu*.")
        );
        return;
      }
      if (isPoliteEnd(text) || shouldEndAfterMoreHelpReply(text)) {
        sessions.set(phoneE164, { started: false, step: "idle", pending: {} });
        await sendText(
          from,
          await friendly("Por nada! Se precisar, é só chamar. 👋")
        );
        return;
      }
      sessions.set(phoneE164, { started: false, step: "idle", pending: {} });
      await sendText(
        from,
        await friendly("Qualquer coisa, estou por aqui. Até mais! 👋")
      );
      return;
    }

    case "awaiting_event": {
      const lista = ((sess as any).pending?.eventos as any[]) || [];
      const raw = (text || "").trim();
      const asNum = Number(raw);

      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= lista.length) {
        const ev = lista[asNum - 1];
        (sess as any).event = {
          id: String(ev.id),
          title: String(ev.titulo || "Evento selecionado"),
          slug: String(
            ev.slug || ev.Slug || ev.url_amigavel || ev.url || ""
          ).trim(),
        };
      } else {
        const idx = chooseIndexByText(raw, lista, (ev: any) => {
          const cat = ev.categoria ? ` ${ev.categoria}` : "";
          return `${ev.titulo}${cat}`;
        });
        if (idx >= 0) {
          const ev = lista[idx];
          (sess as any).event = {
            id: String(ev.id),
            title: String(ev.titulo || "Evento selecionado"),
            slug: String(
              ev.slug || ev.Slug || ev.url_amigavel || ev.url || ""
            ).trim(),
          };
        } else {
          await sendText(
            from,
            await friendly(
              "Não encontrei. Pode digitar parte do nome do evento ou escolher pelo número?"
            )
          );
          await askEvent(from, sess);
          return;
        }
      }

      await sendText(
        from,
        await friendly(`Perfeito! Anotei o evento **${sess?.event?.title}**.`)
      );
      const desired = (sess as any).pending?.desiredIssue as string | undefined;
      (sess as any).pending.desiredIssue = undefined;

      if (desired === "iss_cat") return askCategoryOptions(from, sess);
      if (desired === "iss_size") return askTshirtOptions(from, sess);
      if (desired === "iss_team") return askTeamName(from, sess);
      if (desired === "iss_cancel") return askCancelOptions(from, sess);
      if (desired === "iss_transfer") return startTransferFlow(from, sess);
      if (desired === "iss_faq_contact") {
        await sendFaqOrganizerLink(from, sess);
        return;
      }

      return askIssue(from, sess);
    }

    case "idle":
    default:
      break;
  }

  // Se há intenção pendente que depende de evento
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
