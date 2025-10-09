export type Step =
  | "idle"
  | "awaiting_cpf"
  | "awaiting_email_confirm"
  | "awaiting_email_verification"
  | "awaiting_birthdate_confirm"
  | "awaiting_birthdate_verification"
  | "awaiting_event"
  | "awaiting_issue"
  | "awaiting_more_help"
  | "awaiting_cpf_verify";

export type Session = {
  started: boolean;
  step: Step;
  user?: {
    id?: string | number;
    name?: string;
    email?: string;
    birthDate?: string; // ISO: yyyy-mm-dd
    cpf?: string; // só dígitos
  };
  event?: {
    id?: string;
    title?: string;
  };
  pending?: {
    newEmail?: string;
    newBirth?: string; // ISO
    eventos?: any[]; // <- lista de eventos mostrada ao usuário
    cpfChoiceMenu?: boolean; // flag para saber se mostramos o menu "corrigir/cadastro"
  };
};
