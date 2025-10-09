// src/bot.ts
import type { Message } from "whatsapp-web.js";
import { sendText } from "./wa";
import { Session } from "./type";
import {
  norm,
  onlyDigits,
  toISODate,
  fetchJSON,
  ensureSession,
  formatISOtoBR,
  friendly,
  parseBrDateTime,
  daysDiffFromNow,
  formatCPF,
  clearEventContext,
  classifyIssue,
  aiSelectFromList,
  wantsMenu,
  isYes,
  isNo,
  isSwitchEvent,
  isGoMenu,
  extractCPF,
  isFixCPF,
  isCreateAccount,
} from "./helpers";

/** =========================
 *   Gatilho para iniciar
 *  ========================= */
const TRIGGER_PHRASE = (process.env.TRIGGER_PHRASE || "Olá Bro").trim();
const triggerNorm = norm(TRIGGER_PHRASE);

/** =========================
 *   Sessões em memória
 *  ========================= */
const sessions = new Map<string, Session>(); // key = phoneE164

/** =========================
 *   Passos do fluxo
 *  ========================= */
async function askCPF(to: string, sess: Session) {
  sess.step = "awaiting_cpf";
  const msg = await friendly(
    "Para começar, pode me informar **seu CPF de cadastro**? Pode digitar com ou sem pontos e traço, eu organizo por aqui. 🙂"
  );
  await sendText(to, msg);
}

async function askCPFVerify(to: string, sess: Session) {
  if (!sess.user?.cpf) return askCPF(to, sess);
  sess.step = "awaiting_cpf_verify";
  const msg = await friendly(
    `Encontrei seu CPF como **${formatCPF(sess.user.cpf)}**. Está correto?`
  );
  await sendText(to, msg);
}

async function greetFoundUser(to: string, name: string) {
  const msg = await friendly(
    `Oi, ${name}! Que bom te ver por aqui — encontrei seu cadastro certinho. Vamos seguir com o atendimento?`
  );
  await sendText(to, msg);
}

async function askEvent(to: string, sess: Session) {
  const data = await fetchJSON(`${process.env.API}/events_list.php?status=2`);
  const eventos = Array.isArray(data?.evento) ? data.evento : [];

  if (!eventos.length) {
    const msg = await friendly(
      "No momento não encontrei eventos abertos. Se quiser, posso te avisar quando abrirem novas inscrições."
    );
    await sendText(to, msg);
    await askIssue(to, sess);
    return;
  }

  (sess as any).pending = { ...((sess as any).pending || {}), eventos };

  let menu = "";
  eventos.forEach((ev: any, i: number) => {
    const n = i + 1;
    const cat = ev.categoria ? ` — ${ev.categoria}` : "";
    menu += `${n}. ${ev.titulo}${cat}\n`;
  });
  //menu += "\nEx.: 1";

  const msg = await friendly(
    "Legal! Em qual **evento** você quer atendimento?"
  );
  await sendText(to, msg);
  await sendText(to, menu);

  (sess as any).step = "awaiting_event";
}

/** =========================
 *   Troca de categoria — com “0. Trocar de evento”
 *  ========================= */
async function askCategoryOptions(to: string, sess: Session) {
  if (!sess.event?.id || !sess.user?.id) {
    await sendText(
      to,
      await friendly("Antes, preciso do **evento** e do seu cadastro.")
    );
    await askEvent(to, sess);
    return;
  }

  try {
    const url = `${
      process.env.API
    }/event_category_list.php?id=${encodeURIComponent(
      String(sess.event.id)
    )}&userID=${encodeURIComponent(String(sess.user.id))}&status=1`;

    const data = await fetchJSON(url);
    const categorias = Array.isArray(data?.categoria_evento)
      ? data.categoria_evento
      : [];

    if (!categorias.length) {
      await sendText(
        to,
        await friendly(
          "Não encontrei opções de categoria disponíveis para este evento.\n\nO que você prefere?\n1. Falar com atendente\n2. Voltar ao menu"
        )
      );
      (sess as any).step = "awaiting_no_category_action";
      return;
    }

    (sess as any).pending = {
      ...((sess as any).pending || {}),
      categoryOptions: categorias,
    };

    let menu =
      `Evento selecionado: **${sess.event.title}**\n` +
      "Escolha a **nova categoria**:\n\n";
    categorias.forEach((c: any, i: number) => {
      const n = i + 1;
      const valor = c.valor_formatado ? ` — R$ ${c.valor_formatado}` : "";
      const taxa = c.taxa_formatado ? ` (taxa R$ ${c.taxa_formatado})` : "";
      menu += `${n}. ${c.titulo}${valor}${taxa}\n`;
    });
    //menu += "\nEx.: 1";

    await sendText(
      to,
      await friendly(
        "Estas são as categorias disponíveis. Selecione a opção desejada:"
      )
    );
    await sendText(to, menu);

    (sess as any).step = "awaiting_category_choice";
  } catch {
    await sendText(
      to,
      await friendly(
        "Não consegui listar as categorias agora.\n\nO que você prefere?\n1. Falar com atendente\n2. Voltar ao menu"
      )
    );
    (sess as any).step = "awaiting_no_category_action";
  }
}

async function applyCategoryChange(
  to: string,
  sess: Session,
  inscricaoID: string
) {
  if (!sess.user?.id || !sess.event?.id) {
    await sendText(
      to,
      await friendly(
        "Parece que perdi o contexto do evento. Vamos tentar de novo?"
      )
    );
    await askEvent(to, sess);
    return;
  }

  try {
    const body = {
      userID: sess.user.id,
      eventID: sess.event.id,
      inscricaoID,
    };

    await fetchJSON(`${process.env.API}/inscricao_put.php`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await sendText(
      to,
      await friendly(
        `Prontinho! Solicitei a **troca de categoria** no evento **${sess.event.title}**. 🎉`
      )
    );

    (sess as any).step = "awaiting_more_help";
    await sendText(
      to,
      await friendly("Posso te ajudar em **mais alguma coisa**?")
    );
  } catch {
    await sendText(
      to,
      await friendly(
        "Algo não deu certo ao solicitar a troca. Vamos repetir o processo?"
      )
    );
    await askCategoryOptions(to, sess);
  }
}

/** =========================
 *   Troca de tamanho de camiseta — lista por API + PUT
 *  ========================= */
async function askTshirtOptions(to: string, sess: Session) {
  if (!sess.event?.id || !sess.user?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_size",
    };
    clearEventContext(sess, { keepDesired: true });
    await sendText(
      to,
      await friendly("Para essa solicitação preciso saber o **evento**.")
    );
    await askEvent(to, sess);
    return;
  }

  try {
    const url = `${
      process.env.API
    }/event_tshirt_size.php?id=${encodeURIComponent(String(sess.event.id))}`;
    const data = await fetchJSON(url);

    const infantil = Array.isArray(data?.camisetas?.infantil)
      ? data.camisetas.infantil
      : [];
    const adulto = Array.isArray(data?.camisetas?.adulto)
      ? data.camisetas.adulto
      : [];

    const infAvail = infantil.filter((i: any) => Number(i?.disponiveis) > 0);
    const adAvail = adulto.filter((i: any) => Number(i?.disponiveis) > 0);

    if (!infAvail.length && !adAvail.length) {
      await sendText(
        to,
        await friendly(
          "Não há tamanhos de camiseta disponíveis no momento para este evento.\n\nO que você prefere?\n1. Falar com atendente\n2. Voltar ao menu"
        )
      );
      (sess as any).step = "awaiting_no_tshirt_action";
      return;
    }

    const map: Record<number, { tamanho: string; label: string }> = {};
    let idx = 1;
    let menu =
      `Evento selecionado: **${sess.event.title}**\n` +
      "Escolha o **novo tamanho de camiseta**:\n\n";

    if (infAvail.length) {
      menu += "INFANTIL:\n";
      infAvail.forEach((item: any) => {
        map[idx] = {
          tamanho: String(item.tamanho),
          label: String(item.label || item.tamanho),
        };
        menu += `${idx}. ${item.label || item.tamanho}\n`;
        idx++;
      });
      menu += "\n";
    }

    if (adAvail.length) {
      menu += "ADULTO:\n";
      adAvail.forEach((item: any) => {
        map[idx] = {
          tamanho: String(item.tamanho),
          label: String(item.label || item.tamanho),
        };
        menu += `${idx}. ${item.label || item.tamanho}\n`;
        idx++;
      });
      menu += "\n";
    }

    //menu += "Ex.: 1";

    (sess as any).pending = {
      ...((sess as any).pending || {}),
      tshirtMap: map,
    };

    await sendText(
      to,
      await friendly(
        "Confira as opções abaixo e selecione o novo tamanho desejado:"
      )
    );
    await sendText(to, menu);
    (sess as any).step = "awaiting_tshirt_choice";
  } catch {
    await sendText(
      to,
      await friendly(
        "Não consegui listar os tamanhos agora.\n\nO que você prefere?\n1. Falar com atendente\n2. Voltar ao menu"
      )
    );
    (sess as any).step = "awaiting_no_tshirt_action";
  }
}

async function applyTshirtChange(
  to: string,
  sess: Session,
  tshirtSize: string
) {
  if (!sess.user?.id || !sess.event?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_size",
    };
    clearEventContext(sess, { keepDesired: true });
    await sendText(
      to,
      await friendly(
        "Perdi o contexto do evento. Vamos escolhê-lo novamente rapidinho?"
      )
    );
    await askEvent(to, sess);
    return;
  }

  try {
    const body = {
      userID: sess.user.id,
      eventID: sess.event.id,
      tshirtSize, // salva pelo nome (ex.: P, BM, GG, 2_AZUL, etc.)
    };

    await fetchJSON(`${process.env.API}/inscricao_put.php`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await sendText(
      to,
      await friendly(
        `Beleza! Solicitei a troca do tamanho para **${tshirtSize.toUpperCase()}** no evento **${
          sess.event.title
        }**. ✅`
      )
    );
    (sess as any).step = "awaiting_more_help";
    await sendText(
      to,
      await friendly("Posso te ajudar em **mais alguma coisa**?")
    );
  } catch {
    await sendText(
      to,
      await friendly(
        "Não consegui aplicar a troca agora. Vamos tentar novamente?"
      )
    );
    await askTshirtOptions(to, sess);
  }
}

/** =========================
 *   Troca de equipe — com confirmação e PUT
 *  ========================= */
async function askTeamName(to: string, sess: Session) {
  if (!sess.event?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_team",
    };
    clearEventContext(sess, { keepDesired: true });
    await sendText(
      to,
      await friendly("Para essa solicitação preciso saber o **evento**.")
    );
    await askEvent(to, sess);
    return;
  }
  const msg = await friendly(
    `Evento selecionado: **${sess.event.title}**\nAntes de confirmar, me informe o **nome da equipe** como deve aparecer.`
  );
  await sendText(to, msg);
  (sess as any).step = "awaiting_team_name";
}

async function confirmTeamName(to: string, sess: Session, team: string) {
  (sess as any).pending = { ...((sess as any).pending || {}), teamName: team };
  const msg = await friendly(
    `Você informou **${team}** como nome da equipe no evento **${
      sess.event?.title || ""
    }**. Está correto?`
  );
  await sendText(to, msg);
  (sess as any).step = "awaiting_team_confirm";
}

async function applyTeamChange(to: string, sess: Session) {
  if (!sess.user?.id || !sess.event?.id) {
    await sendText(
      to,
      await friendly(
        "Preciso do **evento** e do seu cadastro. Vamos escolher o evento?"
      )
    );
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_team",
    };
    clearEventContext(sess, { keepDesired: true });
    await askEvent(to, sess);
    return;
  }

  const teamName = (sess as any).pending?.teamName?.trim();
  if (!teamName) {
    await askTeamName(to, sess);
    return;
  }

  try {
    const body = {
      userID: sess.user.id,
      eventID: sess.event.id,
      equipe: teamName,
    };

    await fetchJSON(`${process.env.API}/inscricao_put.php`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await sendText(
      to,
      await friendly(
        `Perfeito! Atualizei o **nome da equipe** para **${teamName}** no evento **${sess.event.title}**. ✅`
      )
    );
    (sess as any).step = "awaiting_more_help";
    await sendText(
      to,
      await friendly("Posso te ajudar em **mais alguma coisa**?")
    );
  } catch {
    await sendText(
      to,
      await friendly(
        "Não consegui salvar o nome da equipe agora. Quer tentar novamente me enviando o nome outra vez?"
      )
    );
    await askTeamName(to, sess);
  }
}

/** =========================
 *   Cancelar inscrição — listar, validar 7 dias, confirmar e refund
 *  ========================= */
async function askCancelOptions(to: string, sess: Session) {
  if (!sess.user?.id || !sess.event?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_cancel",
    };
    clearEventContext(sess, { keepDesired: true });
    await sendText(
      to,
      await friendly("Para cancelar, preciso saber o **evento**.")
    );
    await askEvent(to, sess);
    return;
  }

  try {
    const url = `${
      process.env.API
    }/user_events_list.php?userID=${encodeURIComponent(
      String(sess.user.id)
    )}&eventID=${encodeURIComponent(String(sess.event.id))}`;
    const data = await fetchJSON(url);
    const list = Array.isArray(data?.data) ? data.data : [];

    // Filtra por status permitido e janela de 7 dias
    const allowedStatus = new Set(["Pago", "Disponível", "Disponivel"]);
    const now = new Date();

    const elegiveis = list
      .filter((it: any) =>
        allowedStatus.has(String(it.status_pagseguro || it.status || "").trim())
      )
      .map((it: any) => {
        const d = parseBrDateTime(String(it.data || ""), String(it.hora || ""));
        const days = daysDiffFromNow(d);
        return { ...it, _createdAt: d, _days: days };
      })
      .filter((it: any) => it._days <= 7);

    // Se nenhum com status permitido, sugerir trocar de evento
    const temComStatusNaoPermitido =
      list.length > 0 &&
      list.every(
        (it: any) =>
          !allowedStatus.has(
            String(it.status_pagseguro || it.status || "").trim()
          )
      );

    if (temComStatusNaoPermitido) {
      await sendText(
        to,
        await friendly(
          `Parece que suas inscrições no evento **${sess.event.title}** não estão com status elegível para cancelamento (Pago/Disponível).\n\nSugiro **trocar de evento** ou falar com um atendente:\n1. Trocar de evento\n2. Falar com atendente\n3. Voltar ao menu`
        )
      );
      (sess as any).step = "awaiting_cancel_redirect";
      return;
    }

    if (!elegiveis.length) {
      await sendText(
        to,
        await friendly(
          `Não encontrei inscrições **elegíveis** para cancelamento no evento **${sess.event.title}** (precisa ter até 7 dias da compra e status Pago/Disponível).\n\nO que você prefere?\n1. Falar com atendente\n2. Voltar ao menu`
        )
      );
      (sess as any).step = "awaiting_no_cancel_action";
      return;
    }

    // Monta o menu com cod_pagseguro + data/hora
    let idx = 1;
    const map: Record<
      number,
      { reference: string; titulo: string; data: string; hora: string }
    > = {};
    let menu =
      `Evento selecionado: **${sess.event.title}**\n` +
      "Escolha a **inscrição** que deseja cancelar:\n\n";
    //menu += "0. Trocar de evento\n\n";

    elegiveis.forEach((it: any) => {
      map[idx] = {
        reference: String(it.cod_pagseguro || "").trim(),
        titulo: String(it.event?.titulo || sess.event?.title || ""),
        data: String(it.data || ""),
        hora: String(it.hora || ""),
      };
      menu += `${idx}. ${map[idx].reference} — ${map[idx].titulo} — ${map[idx].data} ${map[idx].hora}\n`;
      idx++;
    });

    //menu += "\nEx.: 1";

    (sess as any).pending = {
      ...((sess as any).pending || {}),
      cancelMap: map,
    };

    await sendText(
      to,
      await friendly(
        "Atenção: ao prosseguir, vamos solicitar o **cancelamento** desta inscrição."
      )
    );
    await sendText(to, menu);
    (sess as any).step = "awaiting_cancel_choice";
  } catch {
    await sendText(
      to,
      await friendly(
        "Não consegui listar suas inscrições agora.\n\nO que você prefere?\n1. Falar com atendente\n2. Voltar ao menu"
      )
    );
    (sess as any).step = "awaiting_no_cancel_action";
  }
}

async function confirmCancel(to: string, sess: Session, ref: string) {
  (sess as any).pending = { ...((sess as any).pending || {}), cancelRef: ref };
  const msg = await friendly(
    `Confirma que deseja **solicitar o cancelamento** da inscrição **${ref}** no evento **${
      sess.event?.title || ""
    }**?\n\n1. Sim\n2. Não`
  );
  await sendText(to, msg);
  (sess as any).step = "awaiting_cancel_confirm";
}

async function applyCancel(to: string, sess: Session) {
  const ref = (sess as any).pending?.cancelRef;
  if (!ref) {
    await askCancelOptions(to, sess);
    return;
  }

  const nomeCliente = (sess.user?.name || "").trim();
  const emailCliente = (sess.user?.email || "").trim();

  // Faltou nome → pede o nome primeiro
  if (!nomeCliente) {
    (sess as any).step = "awaiting_refund_name";
    await sendText(
      to,
      await friendly(
        "Para concluir o cancelamento, me diga seu **nome completo** (como no cadastro)."
      )
    );
    return;
  }

  // Tem nome, mas faltou e‑mail → pede o e‑mail
  if (!emailCliente) {
    (sess as any).step = "awaiting_refund_email";
    await sendText(
      to,
      await friendly(
        "Perfeito! Agora me informe seu **e‑mail de cadastro** (ex.: nome@exemplo.com)."
      )
    );
    return;
  }

  try {
    const url =
      `${process.env.URL}/evento/refund.php` +
      `?reference_id=${encodeURIComponent(String(ref))}` +
      `&nome_cliente=${encodeURIComponent(nomeCliente)}` +
      `&email_cliente=${encodeURIComponent(emailCliente)}`;

    await fetchJSON(url);

    await sendText(
      to,
      await friendly(
        `Prontinho! Solicitei o **cancelamento** da inscrição **${ref}** no evento **${
          sess.event?.title || ""
        }**.`
      )
    );
    (sess as any).step = "awaiting_more_help";
    await sendText(
      to,
      await friendly("Posso te ajudar em **mais alguma coisa**?")
    );
  } catch {
    await sendText(
      to,
      await friendly(
        "Não consegui solicitar o cancelamento agora. Você quer tentar novamente ou falar com um atendente?\n1. Tentar novamente\n2. Falar com atendente\n3. Voltar ao menu"
      )
    );
    (sess as any).step = "awaiting_cancel_retry";
  }
}

/** =========================
 *   Fluxo: Esqueci a senha
 *  ========================= */
async function startForgotPassword(to: string, sess: Session) {
  (sess as any).step = "awaiting_email_confirm";
  const msg = await friendly(
    "Sem problemas! Para te ajudar com a senha, me confirma o **e‑mail do cadastro**?"
  );
  await sendText(to, msg);
}

async function handleEmailConfirm(to: string, sess: Session, text: string) {
  const email = text.trim();
  (sess as any).pending = { ...((sess as any).pending || {}), newEmail: email };

  (sess as any).step = "awaiting_email_verification";
  const msg = await friendly(
    `Você informou o e‑mail **${email}**. Está correto?`
  );
  await sendText(to, msg);
}

async function handleEmailVerification(
  to: string,
  sess: Session,
  text: string
) {
  const ans = norm(text);
  console.log("handleEmailVerification:", { ans });
  console.log(isYes(ans), isNo(ans));
  if (isYes(ans)) {
    (sess as any).step = "awaiting_birthdate_confirm";
    const msg = await friendly(
      "Obrigada! Agora me informe sua **data de nascimento** (ex.: 23/03/1965)."
    );
    await sendText(to, msg);
    return;
  }
  if (isNo(ans)) {
    (sess as any).step = "awaiting_email_confirm";
    const msg = await friendly("Sem problema! Pode informar o e‑mail correto?");
    await sendText(to, msg);
    return;
  }
  await sendText(to, await friendly("Não consegui entender, pode repetir?"));
}

async function handleBirthdateConfirm(to: string, sess: Session, text: string) {
  const iso = toISODate(text);
  if (!iso) {
    return sendText(
      to,
      await friendly("Consegue me enviar a data no formato **dd/mm/aaaa**?")
    );
  }
  const br = formatISOtoBR(iso);
  (sess as any).pending = { ...((sess as any).pending || {}), newBirth: iso };

  (sess as any).step = "awaiting_birthdate_verification";
  const msg = await friendly(`Você informou a data **${br}**. Está correta?`);
  await sendText(to, msg);
}

async function handleBirthdateVerification(
  to: string,
  sess: Session,
  text: string
) {
  const ans = norm(text);
  if (isYes(ans)) {
    await finishForgotPassword(to, sess);
    return;
  }
  if (isNo(ans)) {
    (sess as any).step = "awaiting_birthdate_confirm";
    const msg = await friendly(
      "Tudo bem! Me envie novamente sua **data de nascimento** (ex.: 23/03/1965)."
    );
    await sendText(to, msg);
    return;
  }
  await sendText(to, await friendly("Não consegui entender, pode repetir?"));
}

async function finishForgotPassword(to: string, sess: Session) {
  const currentEmail = sess.user?.email?.trim();
  const currentBirth = sess.user?.birthDate?.trim();

  const newEmail = (sess as any).pending?.newEmail?.trim();
  const newBirthISO = toISODate((sess as any).pending?.newBirth || "");

  let needUpdate = false;
  const body: Record<string, any> = { userID: sess.user?.id };

  if (
    newEmail &&
    currentEmail &&
    newEmail.toLowerCase() !== currentEmail.toLowerCase()
  ) {
    body.email = newEmail;
    needUpdate = true;
  }
  if (newBirthISO && currentBirth && newBirthISO !== currentBirth) {
    body.birthdate = newBirthISO;
    needUpdate = true;
  }

  if (needUpdate && sess.user?.id) {
    try {
      await fetchJSON(`${process.env.API}/user_put.php`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const okMsg = await friendly(
        "Prontinho! Atualizei seus dados e já deixei tudo certo para você recuperar a senha. 💙"
      );
      await sendText(to, okMsg);
    } catch {
      const errMsg = await friendly(
        "Tentei atualizar seus dados, mas algo não deu certo agora. Posso te passar o link de recuperação e você tenta por lá?"
      );
      await sendText(to, errMsg);
    }
  }

  const link = `${process.env.URL}/v2/esquecisenha.php`;
  const finalMsg = await friendly(
    `Aqui está o link para redefinir sua senha com segurança: ${link}\nSe precisar, fico por aqui.`
  );
  await sendText(to, finalMsg);

  (sess as any).step = "awaiting_more_help";
  const more = await friendly("Posso te ajudar em **mais alguma coisa**?");
  await sendText(to, more);
}

/** =========================
 *   Menu de serviços
 *  ========================= */
async function askIssue(to: string, sess: Session) {
  const msg = await friendly(
    `Como posso ajudar? Você pode **digitar o nome** (ex.: "trocar tamanho", "cancelar inscrição") ou usar números:\n
      1. Esqueci a Senha
      2. Troca de Categoria
      3. Troca de Tamanho Camiseta
      4. Troca de Nome da Equipe
      5. Cancelar Inscrição`
  );
  await sendText(to, msg);
  (sess as any).step = "awaiting_issue";
}

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

      if (sess.user?.cpf) {
        await askCPFVerify(from, sess);
      } else {
        await askCPF(from, sess);
      }
    }
    return;
  }

  switch ((sess as any).step) {
    case "awaiting_event": {
      const lista = ((sess as any).pending?.eventos as any[]) || [];
      const raw = (text || "").trim();

      // 1) número ainda funciona
      const asNum = Number(raw);
      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= lista.length) {
        const ev = lista[asNum - 1];
        const evId = String(ev.id);
        const evTitle = String(ev.titulo || "Evento selecionado");
        sess.event = { id: evId, title: evTitle };
        await sendText(
          from,
          await friendly(`Perfeito! Anotei o evento **${evTitle}**.`)
        );

        const desired = (sess as any).pending?.desiredIssue as
          | string
          | undefined;
        if (desired === "iss_cat") {
          (sess as any).pending.desiredIssue = undefined;
          await askCategoryOptions(from, sess);
          return;
        }
        if (desired === "iss_size") {
          (sess as any).pending.desiredIssue = undefined;
          await askTshirtOptions(from, sess);
          return;
        }
        if (desired === "iss_team") {
          (sess as any).pending.desiredIssue = undefined;
          await askTeamName(from, sess);
          return;
        }
        if (desired === "iss_cancel") {
          (sess as any).pending.desiredIssue = undefined;
          await askCancelOptions(from, sess);
          return;
        }
        await askIssue(from, sess);
        return;
      }

      // 2) texto livre -> escolher evento pelo título/categoria
      const idx = await aiSelectFromList(raw, lista, (ev: any) => {
        const cat = ev.categoria ? ` ${ev.categoria}` : "";
        return `${ev.titulo}${cat}`;
      });

      if (idx >= 0) {
        const ev = lista[idx];
        const evId = String(ev.id);
        const evTitle = String(ev.titulo || "Evento selecionado");
        sess.event = { id: evId, title: evTitle };
        await sendText(
          from,
          await friendly(`Perfeito! Anotei o evento **${evTitle}**.`)
        );

        const desired = (sess as any).pending?.desiredIssue as
          | string
          | undefined;
        if (desired === "iss_cat") {
          (sess as any).pending.desiredIssue = undefined;
          await askCategoryOptions(from, sess);
          return;
        }
        if (desired === "iss_size") {
          (sess as any).pending.desiredIssue = undefined;
          await askTshirtOptions(from, sess);
          return;
        }
        if (desired === "iss_team") {
          (sess as any).pending.desiredIssue = undefined;
          await askTeamName(from, sess);
          return;
        }
        if (desired === "iss_cancel") {
          (sess as any).pending.desiredIssue = undefined;
          await askCancelOptions(from, sess);
          return;
        }
        await askIssue(from, sess);
        return;
      }

      await sendText(
        from,
        await friendly(
          "Não encontrei. Pode digitar parte do nome do evento ou escolher pelo número da lista?"
        )
      );
      await askEvent(from, sess);
      return;
    }

    case "awaiting_issue": {
      const option = norm(text);

      // ainda aceita números e alguns aliases simples
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

      let selected = directMap[option];

      if (!selected) {
        // tenta IA
        selected = await classifyIssue(text);
      }

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

        case "iss_cat": {
          if (!sess.event?.id) {
            (sess as any).pending = {
              ...((sess as any).pending || {}),
              desiredIssue: "iss_cat",
            };
            clearEventContext(sess, { keepDesired: true });
            await askEvent(from, sess);
            return;
          }
          await askCategoryOptions(from, sess);
          return;
        }

        case "iss_size": {
          if (!sess.event?.id) {
            (sess as any).pending = {
              ...((sess as any).pending || {}),
              desiredIssue: "iss_size",
            };
            clearEventContext(sess, { keepDesired: true });
            await askEvent(from, sess);
            return;
          }
          await askTshirtOptions(from, sess);
          return;
        }

        case "iss_team": {
          if (!sess.event?.id) {
            (sess as any).pending = {
              ...((sess as any).pending || {}),
              desiredIssue: "iss_team",
            };
            clearEventContext(sess, { keepDesired: true });
            await askEvent(from, sess);
            return;
          }
          await askTeamName(from, sess);
          return;
        }

        case "iss_cancel": {
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
          await askCancelOptions(from, sess);
          return;
        }

        case "choose_event":
          await askEvent(from, sess);
          return;
      }
    }

    // Categoria: sem opções — ação do usuário
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

    // Tamanho: sem opções — ação do usuário
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

    // Cancelamento: nenhuma opção elegível — ação
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

    // Cancelamento: status não elegível — redirecionamento
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

    // Escolha de categoria (0 = trocar de evento | 1..N = aplicar ou texto parcial)
    case "awaiting_category_choice": {
      const lista = ((sess as any).pending?.categoryOptions as any[]) || [];
      const raw = (text || "").trim();
      const num = Number(raw);

      // 0. Trocar de evento
      if (isSwitchEvent(raw)) {
        (sess as any).pending.desiredIssue = "iss_cat";
        clearEventContext(sess, { keepDesired: true });
        await askEvent(from, sess);
        return;
      }

      // 1. Número da opção continua funcionando
      if (Number.isInteger(num) && num >= 1 && num <= lista.length) {
        const chosen = lista[num - 1];
        const inscricaoID = String(chosen.id);
        await applyCategoryChange(from, sess, inscricaoID);
        return;
      }

      // 2. Texto parcial → tenta IA primeiro
      // concatena campos relevantes (título + descrição + preço + taxa)
      const idxAI = await aiSelectFromList(raw, lista, (c: any) => {
        const tit = String(c.titulo || "");
        const desc = String(c.descricao || "");
        const val = c.valor_formatado ? ` R$ ${c.valor_formatado}` : "";
        const tax = c.taxa_formatado ? ` taxa R$ ${c.taxa_formatado}` : "";
        return `${tit} ${desc}${val}${tax}`;
      });

      if (idxAI >= 0) {
        const chosen = lista[idxAI];
        const inscricaoID = String(chosen.id);
        await applyCategoryChange(from, sess, inscricaoID);
        return;
      }

      // 3. Fallback sem IA: "contains" com normalização e tokenização
      const q = norm(raw);
      const tokens = q.split(/\s+/).filter(Boolean);

      const pickIndex = lista.findIndex((c: any) => {
        const hay = norm(
          [
            c.titulo || "",
            c.descricao || "",
            c.valor_formatado ? `R$ ${c.valor_formatado}` : "",
            c.taxa_formatado ? `taxa R$ ${c.taxa_formatado}` : "",
          ].join(" ")
        );
        // exige que todos os tokens apareçam (match "solto")
        return tokens.every((tk) => hay.includes(tk));
      });

      if (pickIndex >= 0) {
        const chosen = lista[pickIndex];
        const inscricaoID = String(chosen.id);
        await applyCategoryChange(from, sess, inscricaoID);
        return;
      }

      // 4. Não entendeu → repete menu
      await sendText(
        from,
        await friendly(
          "Não consegui entender. Pode repetir? Você pode digitar parte do nome da categoria."
        )
      );
      await askCategoryOptions(from, sess);
      return;
    }

    // Escolha de tamanho (0 = trocar de evento | N = aplicar PUT tshirtSize)
    // Escolha de tamanho (0 = trocar de evento | N = aplicar por número ou texto parcial)
    case "awaiting_tshirt_choice": {
      const raw = (text || "").trim();

      // 0) Trocar de evento
      if (isSwitchEvent(raw)) {
        (sess as any).pending.desiredIssue = "iss_size";
        clearEventContext(sess, { keepDesired: true });
        await askEvent(from, sess);
        return;
      }

      const map: Record<number, { tamanho: string; label: string }> =
        ((sess as any).pending?.tshirtMap as any) || {};

      // 1) Ainda aceita número
      const n = Number(raw);
      if (Number.isInteger(n) && map[n]) {
        await applyTshirtChange(from, sess, map[n].tamanho);
        return;
      }

      // Transforma o map em lista para IA / fallback
      const list = Object.entries(map).map(([idx, v]) => ({
        idx: Number(idx),
        tamanho: String(v.tamanho || ""),
        label: String(v.label || v.tamanho || ""),
      }));

      // Builder de texto de busca (normalizado + sinônimos úteis)
      const buildText = (s: { label: string; tamanho: string }) => {
        // base considera label + tamanho (ex.: "Babylook P", "GG")
        const base = `${s.label} ${s.tamanho}`;
        // normaliza
        const normBase = norm(base);

        // inclui variações úteis para casar: "babylook" <-> "baby look"
        const withSyns = [
          normBase,
          normBase.replace(/\bbaby\s*look\b/g, "babylook"),
          normBase.replace(/\bbabylook\b/g, "baby look"),
          // alguns apelidos comuns
          normBase.replace(/\bbaby\s*look\b/g, "bl"),
          normBase.replace(/\bbabylook\b/g, "bl"),
        ].join(" ");

        return withSyns;
      };

      // 2) Tenta IA primeiro (texto livre: "gg", "baby look p", "infantil m"...)
      const aiIdx = await aiSelectFromList(raw, list, buildText);
      if (aiIdx >= 0) {
        const chosen = list[aiIdx];
        await applyTshirtChange(from, sess, chosen.tamanho);
        return;
      }

      // 3) Fallback: tokenização + contains em label/tamanho + sinônimos
      const q = norm(raw);
      const tokens = q.split(/\s+/).filter(Boolean);

      const pick = list.find((s) => {
        const hay = buildText(s); // já normalizado + sinônimos
        return tokens.every((tk) => hay.includes(tk));
      });

      if (pick) {
        await applyTshirtChange(from, sess, pick.tamanho);
        return;
      }

      // 4) Fallback adicional: comparação "canônica" de tamanho (GG == gg, etc.)
      const sizeOnly = q.replace(/\s+/g, ""); // remove espaços (ex.: "babylookpp" -> "babylookpp")
      const pick2 = list.find((s) => {
        const tCanon = norm(s.tamanho).replace(/\s+/g, "");
        const lCanon = norm(s.label).replace(/\s+/g, "");
        // casa exatamente o tamanho ou parte significativa do label
        return tCanon === sizeOnly || lCanon.includes(sizeOnly);
      });

      if (pick2) {
        await applyTshirtChange(from, sess, pick2.tamanho);
        return;
      }

      // 5) Não entendeu → repete menu com dica
      await sendText(
        from,
        await friendly(
          'Não consegui entender. Você pode digitar parte do nome, por exemplo: "gg", "baby look p", "infantil m".'
        )
      );
      await askTshirtOptions(from, sess);
      return;
    }

    // Cancelar: escolha (0 = trocar evento | N = escolher ref e confirmar)
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

    // Cancelar: confirmação final
    case "awaiting_cancel_confirm": {
      const ans = norm(text);
      if (isYes(ans)) {
        await applyCancel(from, sess);
        return;
      }
      if (isNo(ans)) {
        // encerra o fluxo de cancelamento
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

    // Cancelar: retry/atendente/menu
    case "awaiting_cancel_retry":
      {
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

      async function applyCancel(to: string, sess: Session) {
        const ref = (sess as any).pending?.cancelRef;
        if (!ref) {
          await askCancelOptions(to, sess);
          return;
        }

        const nomeCliente = (sess.user?.name || "").trim();
        const emailCliente = (sess.user?.email || "").trim();

        // Faltou nome → pede o nome primeiro
        if (!nomeCliente) {
          (sess as any).step = "awaiting_refund_name";
          await sendText(
            to,
            await friendly(
              "Para concluir o cancelamento, me diga seu **nome completo** (como no cadastro)."
            )
          );
          return;
        }

        // Tem nome, mas faltou e‑mail → pede o e‑mail
        if (!emailCliente) {
          (sess as any).step = "awaiting_refund_email";
          await sendText(
            to,
            await friendly(
              "Perfeito! Agora me informe seu **e‑mail de cadastro** (ex.: nome@exemplo.com)."
            )
          );
          return;
        }

        try {
          const url =
            `${process.env.URL}/sportbro/evento/refund.php` +
            `?reference_id=${encodeURIComponent(String(ref))}` +
            `&nome_cliente=${encodeURIComponent(nomeCliente)}` +
            `&email_cliente=${encodeURIComponent(emailCliente)}`;

          await fetchJSON(url);

          await sendText(
            to,
            await friendly(
              `Prontinho! Solicitei o **cancelamento** da inscrição **${ref}** no evento **${
                sess.event?.title || ""
              }**.`
            )
          );
          (sess as any).step = "awaiting_more_help";
          await sendText(
            to,
            await friendly("Posso te ajudar em **mais alguma coisa**?")
          );
        } catch {
          await sendText(
            to,
            await friendly(
              "Não consegui solicitar o cancelamento agora. Você quer tentar novamente ou falar com um atendente?\n1. Tentar novamente\n2. Falar com atendente\n3. Voltar ao menu"
            )
          );
          (sess as any).step = "awaiting_cancel_retry";
        }
      }

    // Nome da equipe — com 0 = trocar evento
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

    // Confirmação do nome da equipe e PUT
    case "awaiting_team_confirm": {
      const ans = norm(text);
      if (isYes(text)) {
        await applyTeamChange(from, sess);
        return;
      }
      if (isNo(text)) {
        await askTeamName(from, sess);
        return;
      }
      await sendText(from, await friendly("Não entendi, pode repetir?"));
      return;
    }

    case "awaiting_cpf_verify": {
      // se a pessoa já mandou outro CPF direto:
      const maybeCpf = extractCPF(text);
      if (maybeCpf && maybeCpf !== onlyDigits(sess.user?.cpf || "")) {
        // troca o CPF e revalida
        try {
          const data = await fetchJSON(
            `${process.env.API}/user_data.php?document=${maybeCpf}`
          );
          const ok = !!data?.success && !!data?.data;
          if (!ok) {
            (sess as any).pending = {
              ...((sess as any).pending || {}),
              cpfChoiceMenu: true,
            };
            await sendText(
              from,
              await friendly(
                "Não encontrei cadastro com esse novo CPF. Você prefere **corrigir** de novo ou **fazer cadastro**?"
              )
            );
            return;
          }
          const u = data.data;
          const userId = u.id || u.userID || u.userId || u.userid || undefined;
          sess.user = {
            id: userId,
            name: u.name,
            email: u.email,
            birthDate: u.birthDate,
            cpf: maybeCpf,
          };
          await greetFoundUser(from, u.name || "por aqui");
          await askIssue(from, sess);
          return;
        } catch {
          await sendText(
            from,
            await friendly(
              "Não consegui consultar agora. Pode tentar novamente ou dizer *corrigir* para enviar outro CPF?"
            )
          );
          return;
        }
      }

      // sim/não livres
      if (isYes(text)) {
        try {
          const cpf = onlyDigits(sess.user?.cpf || "");
          const data = await fetchJSON(
            `${process.env.API}/user_data.php?document=${cpf}`
          );
          const ok = !!data?.success && !!data?.data;
          if (!ok) {
            await sendText(
              from,
              await friendly(
                "Não consegui confirmar seu cadastro com esse CPF. Me envie o CPF novamente?"
              )
            );
            await askCPF(from, sess);
            return;
          }
          const u = data.data;
          const userId = u.id || u.userID || u.userId || u.userid || undefined;
          sess.user = {
            id: userId,
            name: u.name,
            email: u.email,
            birthDate: u.birthDate,
            cpf,
          };
          await greetFoundUser(from, u.name || "por aqui");
          await askIssue(from, sess);
          return;
        } catch {
          await sendText(
            from,
            await friendly(
              "Tive um problema para consultar seu cadastro agora. Pode me enviar o CPF novamente?"
            )
          );
          await askCPF(from, sess);
          return;
        }
      }

      if (isNo(text)) {
        await askCPF(from, sess);
        return;
      }

      await sendText(
        from,
        await friendly(
          "Se estiver certo, diga *sim*. Se quiser corrigir, diga *corrigir* ou me envie o CPF correto."
        )
      );
      return;
    }

    case "awaiting_cpf": {
      // se o menu de escolha está ativo
      if ((sess as any).pending?.cpfChoiceMenu) {
        // 3.1) Se a pessoa já mandou um CPF novo direto, pega e tenta de novo
        const newCpf = extractCPF(text);
        if (newCpf) {
          (sess as any).pending.cpfChoiceMenu = false;
          const resp = await friendly("Beleza! Vou tentar com esse CPF novo.");
          await sendText(from, resp);
          // reaproveita o fluxo padrão de lookup
          try {
            const data = await fetchJSON(
              `${process.env.API}/user_data.php?document=${newCpf}`
            );
            const ok = !!data?.success && !!data?.data;
            if (!ok) {
              (sess as any).pending.cpfChoiceMenu = true;
              await sendText(
                from,
                await friendly(
                  "Ainda não encontrei cadastro com esse CPF. Prefere **corrigir** de novo ou **fazer cadastro**?"
                )
              );
              return;
            }
            const u = data.data;
            const userId =
              u.id || u.userID || u.userId || u.userid || undefined;
            sess.user = {
              id: userId,
              name: u.name,
              email: u.email,
              birthDate: u.birthDate,
              cpf: newCpf,
            };
            await greetFoundUser(from, u.name || "por aqui");
            (sess as any).pending.cpfChoiceMenu = false;
            await askIssue(from, sess);
            return;
          } catch {
            await sendText(
              from,
              await friendly(
                "Não consegui consultar agora. Tenta me enviar o CPF novamente ou diga *cadastro* para criar sua conta."
              )
            );
            return;
          }
        }

        // 3.2) Intenções livres (corrigir / cadastro)
        if (isFixCPF(text)) {
          (sess as any).pending.cpfChoiceMenu = false;
          await sendText(
            from,
            await friendly("Sem problema! Me envia o CPF correto, por favor.")
          );
          return;
        }
        if (isCreateAccount(text)) {
          (sess as any).pending.cpfChoiceMenu = false;
          const link = `${process.env.URL}/v2/login.php`;
          await sendText(
            from,
            await friendly(
              `Perfeito! Você pode criar sua conta aqui: ${link}. Quando terminar, me avisa.`
            )
          );
          return;
        }

        // 3.3) Ajuda se não entendeu
        await sendText(
          from,
          await friendly(
            "Não entendi bem. Você quer **corrigir o CPF** ou **fazer cadastro**? Pode responder com as palavras ou mandar o CPF novo."
          )
        );
        return;
      }

      // fluxo normal de entrada de CPF (sem menu)
      const cpf = extractCPF(text);
      if (!cpf) {
        return sendText(
          from,
          await friendly(
            "Esse CPF parece incompleto. Me envie com 11 dígitos, por favor."
          )
        );
      }

      try {
        const data = await fetchJSON(
          `${process.env.API}/user_data.php?document=${cpf}`
        );
        const ok = !!data?.success && !!data?.data;
        if (!ok) {
          (sess as any).pending = {
            ...((sess as any).pending || {}),
            cpfChoiceMenu: true,
          };
          await sendText(
            from,
            await friendly(
              "Não encontrei cadastro com esse CPF. Prefere **corrigir** o CPF ou **fazer cadastro**?"
            )
          );
          return;
        }
        const u = data.data;
        const userId = u.id || u.userID || u.userId || u.userid || undefined;
        sess.user = {
          id: userId,
          name: u.name,
          email: u.email,
          birthDate: u.birthDate,
          cpf,
        };
        await greetFoundUser(from, u.name || "por aqui");
        await askIssue(from, sess);
        return;
      } catch {
        await sendText(
          from,
          await friendly(
            "Não consegui consultar agora. Pode tentar novamente em instantes?"
          )
        );
        return;
      }
    }

    case "awaiting_email_confirm": {
      await handleEmailConfirm(from, sess, text);
      return;
    }
    case "awaiting_email_verification": {
      await handleEmailVerification(from, sess, text);
      return;
    }
    case "awaiting_birthdate_confirm": {
      await handleBirthdateConfirm(from, sess, text);
      return;
    }
    case "awaiting_birthdate_verification": {
      await handleBirthdateVerification(from, sess, text);
      return;
    }
    case "awaiting_more_help": {
      const ans = norm(text);
      if (isYes(ans)) {
        await askIssue(from, sess);
        return;
      }
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
