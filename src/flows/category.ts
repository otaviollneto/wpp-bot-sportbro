// src/flows/category.ts
import { sendText } from "../wa";
import { Session } from "../type";
import { fetchJSON, friendly, norm, chooseIndexByText } from "../helpers";

export async function askCategoryOptions(to: string, sess: Session) {
  if (!sess.event?.id || !sess.user?.id) {
    await sendText(
      to,
      await friendly("Antes, preciso do **evento** e do seu cadastro.")
    );
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

    let menu = `Evento selecionado: **${sess.event.title}**\nEscolha a **nova categoria**:\n\n`;
    categorias.forEach((c: any, i: number) => {
      const n = i + 1;
      const valor = c.valor_formatado ? ` — R$ ${c.valor_formatado}` : "";
      const taxa = c.taxa_formatado ? ` (taxa R$ ${c.taxa_formatado})` : "";
      menu += `${n}. ${c.titulo}${valor}${taxa}\n`;
    });

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

export async function applyCategoryChange(
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
    return;
  }

  try {
    const body = { userID: sess.user.id, eventID: sess.event.id, inscricaoID };
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

export async function handleCategoryFreeText(
  raw: string,
  lista: any[]
): Promise<number> {
  const q = norm(raw);
  if (!q || !lista?.length) return -1;

  const tokens = q.split(/\s+/).filter(Boolean);
  const idxStrict = lista.findIndex((c: any) => {
    const hay = norm(
      [
        c.titulo || "",
        c.descricao || "",
        c.valor_formatado ? `R$ ${c.valor_formatado}` : "",
        c.taxa_formatado ? `taxa R$ ${c.taxa_formatado}` : "",
      ].join(" ")
    );
    return tokens.every((tk) => hay.includes(tk));
  });
  if (idxStrict >= 0) return idxStrict;

  const idxFuzzy = chooseIndexByText(raw, lista, (c: any) => {
    const v = c.valor_formatado ? ` R$ ${c.valor_formatado}` : "";
    const t = c.taxa_formatado ? ` taxa R$ ${c.taxa_formatado}` : "";
    return `${c.titulo || ""} ${c.descricao || ""}${v}${t}`;
  });
  return idxFuzzy;
}
