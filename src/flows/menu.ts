import { sendText } from "../wa";
import { Session } from "../type";
import { friendly } from "../helpers";

export async function askIssue(to: string, sess: Session) {
  const msg = await friendly(
    `Como posso ajudar? Você pode **digitar o nome** (ex.: "trocar tamanho", "cancelar inscrição") ou usar números:\n
      1. Esqueci a Senha
      2. Troca de Categoria
      3. Troca de Tamanho Camiseta
      4. Troca de Nome da Equipe
      5. Cancelar Inscrição
      6. Troca de Titularidade`
  );
  await sendText(to, msg);
  (sess as any).step = "awaiting_issue";
}

export async function greetFoundUser(to: string, name: string) {
  await sendText(
    to,
    await friendly(
      `Oi, ${name}! Que bom te ver por aqui — encontrei seu cadastro certinho. Vamos seguir com o atendimento?`
    )
  );
}
