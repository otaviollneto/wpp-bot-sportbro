// src/flows/faq.ts
import { sendText } from "../wa";
import { friendly, norm, isGoMenu, clearEventContext } from "../helpers";
import { askIssue } from "./menu";
import { askEvent } from "./events";

type SessionLike = any;

export async function startFaqFlow(from: string, sess: SessionLike) {
  (sess as any).step = "awaiting_faq_menu";

  const msg = await friendly(
    "Beleza! Me conta o que você quer saber sobre o evento:\n\n" +
      "1. O evento já encerrou?\n" +
      "2. Como trocar titularidade?\n" +
      "3. Documentos para retirada do kit\n" +
      "4. Contato do organizador / página do evento\n" +
      "5. Diferença entre Tempo Líquido e Tempo Bruto\n\n" +
      "Responda com o número da opção."
  );

  await sendText(from, msg);
}

export async function handleFaqFlow(
  from: string,
  sess: SessionLike,
  text: string
) {
  const t = norm(text || "");

  if (isGoMenu(text)) {
    (sess as any).step = "awaiting_issue";
    await askIssue(from, sess);
    return;
  }

  switch (t) {
    case "1": {
      const msg = await friendly(
        "Todos os eventos da Sportbro são criados com um limite técnico de inscrições. " +
          "Esse limite leva em conta não só a quantidade de kits, mas também a formatação da prova, estrutura de apoio e segurança no percurso.\n\n" +
          "Quando esse limite é atingido, não conseguimos abrir novas vagas sem refazer toda a documentação e autorizações dos órgãos responsáveis. " +
          "Por isso, depois de encerradas as inscrições, não é possível ultrapassar esse limite."
      );
      await sendText(from, msg);
      (sess as any).step = "awaiting_more_help";
      await sendText(
        from,
        await friendly("Posso te ajudar com mais alguma dúvida?")
      );
      return;
    }

    case "2": {
      const msg = await friendly(
        "A troca de titularidade é permitida até **10 dias antes da data do evento**.\n\n" +
          "Depois desse prazo, por questão de organização e segurança, a troca só pode ser feita **presencialmente na entrega dos kits**, " +
          "seguindo as orientações da organização no local."
      );
      await sendText(from, msg);
      (sess as any).step = "awaiting_more_help";
      await sendText(
        from,
        await friendly(
          "Quer saber mais alguma coisa sobre o evento ou sua inscrição?"
        )
      );
      return;
    }

    case "3": {
      const msg = await friendly(
        "Para retirada do kit é necessário apenas um **documento oficial com foto** ou uma **foto nítida do documento** no celular.\n\n" +
          "O kit pode ser retirado por terceiros, sem problema, desde que a pessoa apresente o documento (ou foto do documento) do titular da inscrição."
      );
      await sendText(from, msg);
      (sess as any).step = "awaiting_more_help";
      await sendText(
        from,
        await friendly(
          "Ficou com mais alguma dúvida sobre o evento ou sua inscrição?"
        )
      );
      return;
    }

    case "4": {
      (sess as any).pending = {
        ...((sess as any).pending || {}),
        desiredIssue: "iss_faq_contact",
      };

      clearEventContext(sess, { keepDesired: true });

      await sendText(
        from,
        await friendly(
          "Show! Me informa de qual evento você quer o link/contato do organizador.\n" +
            "Você pode escolher pelo número da lista ou digitar parte do nome do evento."
        )
      );

      await askEvent(from, sess);
      return;
    }

    case "5": {
      const msg = await friendly(
        "Nas provas de corrida utilizamos dois tipos de marcação:\n\n" +
          "**➡️ Tempo Bruto**\n" +
          "É o tempo contado desde o momento em que o tiro de largada é dado. Mesmo quem larga atrás tem o tempo bruto iniciado no mesmo instante.\n\n" +
          "**➡️ Tempo Líquido**\n" +
          "É o tempo que começa a contar somente quando o atleta cruza o tapete de largada. Representa seu tempo real de prova.\n\n" +
          "**Por que alguém sobe ao pódio mesmo chegando depois fisicamente?**\n" +
          "Porque, conforme regras oficiais das competições, a classificação geral deve ser feita pelo **Tempo Bruto**. Isso evita vantagem indevida por posicionamento na largada.\n\n" +
          "A classificação por faixa etária normalmente usa **Tempo Líquido**, pois mede apenas a performance individual.\n\n" +
          "Assim, um atleta pode cruzar na sua frente fisicamente, mas ter um **Tempo Bruto menor**, garantindo o pódio — enquanto você pode ter um Tempo Líquido melhor, mas isso não define o pódio da geral."
      );
      await sendText(from, msg);
      (sess as any).step = "awaiting_more_help";
      await sendText(
        from,
        await friendly(
          "Quer saber mais algo sobre tempos, resultados ou provas?"
        )
      );
      return;
    }

    default: {
      const msg = await friendly(
        "Não entendi essa opção. Responda com 1, 2, 3 ou 4.\n" +
          "Se quiser, também pode digitar *menu* para voltar ao início."
      );
      await sendText(from, msg);
      return;
    }
  }
}

export async function sendFaqOrganizerLink(from: string, sess: SessionLike) {
  const ev = (sess as any).event;

  if (!ev?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_faq_contact",
    };

    clearEventContext(sess, { keepDesired: true });

    await sendText(
      from,
      await friendly(
        "Antes, me diz de qual evento você quer falar, assim já te mando o link certinho. 🙂"
      )
    );
    await askEvent(from, sess);
    return;
  }

  const rawSlug =
    (ev as any).slug ||
    (ev as any).Slug ||
    (ev as any).url_amigavel ||
    (ev as any).url ||
    "";
  const slug = String(rawSlug || "").replace(/^\/+/, "");

  const baseV2 =
    process.env.URL_V2 || `${process.env.URL || "https://sportbro.com.br"}/v2`;

  const link = slug ? `${baseV2}/${slug}` : baseV2;

  const msg = await friendly(
    `Aqui está a página oficial do evento **${ev.title || ""}**:\n${link}\n\n` +
      "Por lá você encontra mais detalhes e contatos da organização. 😉"
  );

  await sendText(from, msg);

  (sess as any).step = "awaiting_more_help";
  await sendText(
    from,
    await friendly("Posso te ajudar com mais alguma dúvida?")
  );
}
