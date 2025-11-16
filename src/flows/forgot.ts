import { sendText } from "../wa";
import { Session } from "../type";
import {
  friendly,
  formatISOtoBR,
  toISODate,
  fetchJSON,
  norm,
  isYes,
  isNo,
} from "../helpers";

export async function startForgotPassword(to: string, sess: Session) {
  (sess as any).step = "awaiting_email_confirm";
  await sendText(
    to,
    await friendly(
      "Sem problemas! Para te ajudar com a senha, me confirma o **e-mail do cadastro**, *se não lembrar ou souber* informe seu melhor e-mail."
    )
  );
}

export async function handleEmailConfirm(
  to: string,
  sess: Session,
  text: string
) {
  const email = text.trim();
  (sess as any).pending = { ...((sess as any).pending || {}), newEmail: email };
  (sess as any).step = "awaiting_email_verification";
  await sendText(
    to,
    await friendly(`Você informou o e-mail **${email}**. Está correto?`)
  );
}

export async function handleEmailVerification(
  to: string,
  sess: Session,
  text: string
) {
  const ans = norm(text);
  if (isYes(ans)) {
    (sess as any).step = "awaiting_birthdate_confirm";
    await sendText(
      to,
      "Obrigada! Agora me informe sua **data de nascimento** (ex.: 23/03/1965)."
    );
    return;
  }
  if (isNo(ans)) {
    (sess as any).step = "awaiting_email_confirm";
    await sendText(
      to,
      await friendly("Sem problema! Pode informar o e-mail correto?")
    );
    return;
  }
  await sendText(to, await friendly("Não consegui entender, pode repetir?"));
}

export async function handleBirthdateConfirm(
  to: string,
  sess: Session,
  text: string
) {
  const iso = toISODate(text);
  if (!iso) {
    await sendText(
      to,
      await friendly("Consegue me enviar a data no formato **dd/mm/aaaa**?")
    );
    return;
  }
  const br = formatISOtoBR(iso);
  (sess as any).pending = { ...((sess as any).pending || {}), newBirth: iso };
  (sess as any).step = "awaiting_birthdate_verification";
  await sendText(
    to,
    await friendly(`Você informou a data **${br}**. Está correta?`)
  );
}

export async function handleBirthdateVerification(
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
    await sendText(
      to,
      await friendly(
        "Tudo bem! Me envie novamente sua **data de nascimento** (ex.: 23/03/1965)."
      )
    );
    return;
  }
  await sendText(to, await friendly("Não consegui entender, pode repetir?"));
}

export async function finishForgotPassword(to: string, sess: Session) {
  const currentEmail = sess.user?.email?.trim();
  const currentBirth = sess.user?.birthDate?.trim();

  const newEmail = (sess as any).pending?.newEmail?.trim();
  const newBirthISO = toISODate((sess as any).pending?.newBirth || "");

  const body: Record<string, any> = {
    userID: sess.user?.id,
    email: newEmail,
    birthdate: newBirthISO,
  };

  if (sess.user?.id) {
    try {
      await fetchJSON(`${process.env.API}/user_put.php`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await sendText(
        to,
        await friendly(
          "Prontinho! Atualizei seus dados e já deixei tudo certo para você recuperar a senha. 💙"
        )
      );
    } catch {
      await sendText(
        to,
        await friendly(
          "Tentei atualizar seus dados, mas algo não deu certo agora. Posso te passar o link de recuperação e você tenta por lá?"
        )
      );
    }
  }

  const link = `${process.env.URL}/v2/esquecisenha.php`;
  await sendText(
    to,
    await friendly(
      `Aqui está o link para redefinir sua senha com segurança: ${link}\nSe precisar, fico por aqui.`
    )
  );

  // >>> A PARTIR DAQUI: o fluxo cai em `awaiting_more_help`
  (sess as any).step = "awaiting_more_help";
  await sendText(
    to,
    await friendly("Posso te ajudar em **mais alguma coisa**?")
  );
}
