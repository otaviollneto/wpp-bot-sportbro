import { sendText } from "../wa";
import { Session } from "../type";
import { friendly, formatCPF, onlyDigits, norm, fetchJSON } from "../helpers";
import { greetFoundUser, askIssue } from "./menu";

export async function askCPF(to: string, sess: Session) {
  sess.step = "awaiting_cpf";
  const msg = await friendly(
    "Para começar, pode me informar **seu CPF de cadastro**? Pode digitar com ou sem pontos e traço, eu organizo por aqui. 🙂"
  );
  await sendText(to, msg);
}

export async function askCPFVerify(to: string, sess: Session) {
  if (!sess.user?.cpf) return askCPF(to, sess);
  sess.step = "awaiting_cpf_verify";
  const msg = await friendly(
    `Encontrei seu CPF como **${formatCPF(sess.user.cpf)}**. Está correto?`
  );
  await sendText(to, msg);
}

export async function lookupUserByCPF(cpf: string) {
  const data = await fetchJSON(
    `${process.env.API}/user_data.php?document=${cpf}`
  );
  const ok = !!data?.success && !!data?.data;
  if (!ok) return null;
  const u = data.data;
  const userId = u.id || u.userID || u.userId || u.userid || undefined;
  const phone = u.phone || u.telefone || u.celular || "";
  const phoneDigits = phone ? `+55${onlyDigits(phone)}` : "";
  return {
    id: userId,
    name: u.name,
    email: u.email,
    birthDate: u.birthDate,
    cpf,
    phone: phoneDigits,
  };
}

export async function confirmOrCorrectCPFFlow(
  from: string,
  sess: Session,
  text: string,
  {
    extractCPF,
    isFixCPF,
    isCreateAccount,
    friendly,
  }: {
    extractCPF: (s: string) => string | null;
    isFixCPF: (s: string) => boolean;
    isCreateAccount: (s: string) => boolean;
    friendly: (s: string) => Promise<string>;
  }
) {
  // menu de correção ativo
  if ((sess as any).pending?.cpfChoiceMenu) {
    const newCpf = extractCPF(text);
    if (newCpf) {
      (sess as any).pending.cpfChoiceMenu = false;
      await sendText(
        from,
        await friendly("Beleza! Vou tentar com esse CPF novo.")
      );
      try {
        const user = await lookupUserByCPF(newCpf);
        if (!user) {
          (sess as any).pending.cpfChoiceMenu = true;
          await sendText(
            from,
            await friendly(
              "Ainda não encontrei cadastro com esse CPF. Prefere **corrigir** de novo ou **fazer cadastro**?"
            )
          );
          return { done: false };
        }
        sess.user = user;
        await greetFoundUser(from, user.name || "por aqui");
        (sess as any).pending.cpfChoiceMenu = false;
        await askIssue(from, sess);
        return { done: true };
      } catch {
        await sendText(
          from,
          await friendly(
            "Não consegui consultar agora. Tenta me enviar o CPF novamente ou diga *cadastro* para criar sua conta."
          )
        );
        return { done: false };
      }
    }

    if (isFixCPF(text)) {
      (sess as any).pending.cpfChoiceMenu = false;
      await sendText(
        from,
        await friendly("Sem problema! Me envia o CPF correto, por favor.")
      );
      return { done: false };
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
      return { done: false };
    }

    await sendText(
      from,
      await friendly(
        "Não entendi bem. Você quer **corrigir o CPF** ou **fazer cadastro**? Pode responder com as palavras ou mandar o CPF novo."
      )
    );
    return { done: false };
  }

  // fluxo normal
  const maybe = extractCPF(text);
  if (!maybe) {
    await sendText(
      from,
      await friendly(
        "Esse CPF parece incompleto. Me envie com 11 dígitos, por favor."
      )
    );
    return { done: false };
  }

  try {
    const user = await lookupUserByCPF(maybe);
    if (!user) {
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
      return { done: false };
    }
    sess.user = user;
    await greetFoundUser(from, user.name || "por aqui");
    await askIssue(from, sess);
    return { done: true };
  } catch {
    await sendText(
      from,
      await friendly(
        "Não consegui consultar agora. Pode tentar novamente em instantes?"
      )
    );
    return { done: false };
  }
}

export async function confirmKnownCPF(
  from: string,
  sess: Session,
  text: string,
  {
    extractCPF,
    isYes,
    isNo,
    friendly,
  }: {
    extractCPF: (s: string) => string | null;
    isYes: (s: string) => boolean;
    isNo: (s: string) => boolean;
    friendly: (s: string) => Promise<string>;
  }
) {
  // usuário mandou outro CPF direto
  const maybeCpf = extractCPF(text);
  if (maybeCpf && maybeCpf !== onlyDigits(sess.user?.cpf || "")) {
    try {
      const user = await lookupUserByCPF(maybeCpf);
      if (!user) {
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
      sess.user = user;
      await greetFoundUser(from, user.name || "por aqui");
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

  // sim/não sobre CPF atual
  if (isYes(text)) {
    try {
      const cpf = onlyDigits(sess.user?.cpf || "");
      const user = await lookupUserByCPF(cpf);
      if (!user) {
        await sendText(
          from,
          await friendly(
            "Não consegui confirmar seu cadastro com esse CPF. Me envie o CPF novamente?"
          )
        );
        return askCPF(from, sess);
      }
      sess.user = user;
      await greetFoundUser(from, user.name || "por aqui");
      await askIssue(from, sess);
      return;
    } catch {
      await sendText(
        from,
        await friendly(
          "Tive um problema para consultar seu cadastro agora. Pode me enviar o CPF novamente?"
        )
      );
      return askCPF(from, sess);
    }
  }

  if (isNo(text)) {
    return askCPF(from, sess);
  }

  await sendText(
    from,
    await friendly(
      "Se estiver certo, diga *sim*. Se quiser corrigir, diga *corrigir* ou me envie o CPF correto."
    )
  );
}
