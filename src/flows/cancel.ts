import { sendText } from "../wa";
import { Session } from "../type";
import {
  fetchJSON,
  friendly,
  parseBrDateTime,
  daysDiffFromNow,
} from "../helpers";

export async function askCancelOptions(to: string, sess: Session) {
  if (!sess.user?.id || !sess.event?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_cancel",
    };
    await sendText(
      to,
      await friendly("Para cancelar, preciso saber o **evento**.")
    );
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

    const allowedStatus = new Set(["Pago", "Disponível", "Disponivel"]);
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

    let idx = 1;
    const map: Record<
      number,
      { reference: string; titulo: string; data: string; hora: string }
    > = {};
    let menu = `Evento selecionado: **${sess.event.title}**\nEscolha a **inscrição** que deseja cancelar:\n\n`;

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

export async function confirmCancel(to: string, sess: Session, ref: string) {
  (sess as any).pending = { ...((sess as any).pending || {}), cancelRef: ref };
  const msg = await friendly(
    `Confirma que deseja **solicitar o cancelamento** da inscrição **${ref}** no evento **${
      sess.event?.title || ""
    }**?\n\n1. Sim\n2. Não`
  );
  await sendText(to, msg);
  (sess as any).step = "awaiting_cancel_confirm";
}

export async function applyCancel(to: string, sess: Session) {
  const ref = (sess as any).pending?.cancelRef;
  if (!ref) {
    await askCancelOptions(to, sess);
    return;
  }

  const nomeCliente = (sess.user?.name || "").trim();
  const emailCliente = (sess.user?.email || "").trim();

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
  if (!emailCliente) {
    (sess as any).step = "awaiting_refund_email";
    await sendText(
      to,
      await friendly(
        "Perfeito! Agora me informe seu **e-mail de cadastro** (ex.: nome@exemplo.com)."
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
