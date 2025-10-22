// src/flows/events.ts
import { sendText } from "../wa";
import { Session } from "../type";
import { aiSelectFromList, fetchJSON, friendly } from "../helpers";

/**
 * Exibe a lista de eventos e seta o step para "awaiting_event".
 */
export async function askEvent(to: string, sess: Session): Promise<void> {
  const data = await fetchJSON(`${process.env.API}/events_list.php?status=2`);
  const eventos = Array.isArray(data?.evento) ? data.evento : [];

  if (!eventos.length) {
    await sendText(
      to,
      await friendly(
        "No momento não encontrei eventos abertos. Se quiser, posso te avisar quando abrirem novas inscrições."
      )
    );
    // O chamador decide o próximo passo (normalmente askIssue)
    return;
  }

  (sess as any).pending = { ...((sess as any).pending || {}), eventos };

  let menu = "";
  eventos.forEach((ev: any, i: number) => {
    const n = i + 1;
    const cat = ev.categoria ? ` — ${ev.categoria}` : "";
    menu += `${n}. ${ev.titulo}${cat}\n`;
  });

  await sendText(
    to,
    await friendly("Legal! Em qual **evento** você quer atendimento?")
  );
  await sendText(to, menu);

  (sess as any).step = "awaiting_event";
}

/**
 * Tenta selecionar um evento pelo número digitado ou por similaridade de texto (IA).
 * Retorna o índice do item em `lista` (>= 0) ou -1 quando não encontra.
 */
export const selectEventByIndexOrAI = async (
  raw: string,
  lista: any[]
): Promise<number> => {
  const asNum = Number(raw);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= lista.length) {
    return asNum - 1;
  }

  const idx = await aiSelectFromList(raw, lista, (ev: any) => {
    const cat = ev.categoria ? ` ${ev.categoria}` : "";
    return `${ev.titulo}${cat}`;
  });

  return typeof idx === "number" ? idx : -1;
};
