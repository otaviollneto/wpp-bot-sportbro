import { sendText } from "../wa.baileys";
import { Session } from "../type";
import { friendly } from "../helpers";

export async function askTeamName(to: string, sess: Session) {
  if (!sess.event?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_team",
    };
    await sendText(
      to,
      await friendly("Para essa solicitação preciso saber o **evento**."),
    );
    return;
  }
  const msg = await friendly(
    `Evento selecionado: **${sess.event.title}**\nAntes de confirmar, me informe o **nome da equipe** como deve aparecer.`,
  );
  await sendText(to, msg);
  (sess as any).step = "awaiting_team_name";
}

export async function confirmTeamName(to: string, sess: Session, team: string) {
  (sess as any).pending = { ...((sess as any).pending || {}), teamName: team };
  const msg = await friendly(
    `Você informou **${team}** como nome da equipe no evento **${
      sess.event?.title || ""
    }**. Está correto?`,
  );
  await sendText(to, msg);
  (sess as any).step = "awaiting_team_confirm";
}

export async function applyTeamChange(to: string, sess: Session) {
  if (!sess.user?.id || !sess.event?.id) {
    (sess as any).pending = {
      ...((sess as any).pending || {}),
      desiredIssue: "iss_team",
    };
    await sendText(
      to,
      await friendly(
        "Preciso do **evento** e do seu cadastro. Vamos escolher o evento?",
      ),
    );
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
    await fetch(`${process.env.API}/inscricao_put.php`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await sendText(
      to,
      await friendly(
        `Perfeito! Atualizei o **nome da equipe** para **${teamName}** no evento **${sess.event.title}**. ✅`,
      ),
    );
    (sess as any).step = "awaiting_more_help";
    await sendText(
      to,
      await friendly("Posso te ajudar em **mais alguma coisa**?"),
    );
  } catch {
    await sendText(
      to,
      await friendly(
        "Não consegui salvar o nome da equipe agora. Quer tentar novamente me enviando o nome outra vez?",
      ),
    );
    await askTeamName(to, sess);
  }
}
