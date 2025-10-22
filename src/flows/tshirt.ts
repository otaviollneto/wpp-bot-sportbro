import { sendText } from "../wa";
import { Session } from "../type";
import { fetchJSON, friendly, norm } from "../helpers";

export async function askTshirtOptions(to: string, sess: Session) {
  if (!sess.event?.id || !sess.user?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_size",
    };
    await sendText(
      to,
      await friendly("Para essa solicitação preciso saber o **evento**.")
    );
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
    let menu = `Evento selecionado: **${sess.event.title}**\nEscolha o **novo tamanho de camiseta**:\n\n`;

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

export async function applyTshirtChange(
  to: string,
  sess: Session,
  tshirtSize: string
) {
  if (!sess.user?.id || !sess.event?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_size",
    };
    await sendText(
      to,
      await friendly(
        "Perdi o contexto do evento. Vamos escolhê-lo novamente rapidinho?"
      )
    );
    return;
  }

  try {
    const body = { userID: sess.user.id, eventID: sess.event.id, tshirtSize };
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

export function matchTshirtByText(
  raw: string,
  map: Record<number, { tamanho: string; label: string }>
) {
  const list = Object.entries(map).map(([idx, v]) => ({
    idx: Number(idx),
    tamanho: String(v.tamanho || ""),
    label: String(v.label || v.tamanho || ""),
  }));

  const buildText = (s: { label: string; tamanho: string }) => {
    const normBase = norm(`${s.label} ${s.tamanho}`);
    return [
      normBase,
      normBase.replace(/\bbaby\s*look\b/g, "babylook"),
      normBase.replace(/\bbabylook\b/g, "baby look"),
      normBase.replace(/\bbaby\s*look\b/g, "bl"),
      normBase.replace(/\bbabylook\b/g, "bl"),
    ].join(" ");
  };

  return { list, buildText };
}
