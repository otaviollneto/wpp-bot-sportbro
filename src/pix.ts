import { QrCodePix } from "qrcode-pix";

export type PixInput = {
  key: string; // chave Pix (telefone, e-mail, EVP, CPF/CNPJ)
  name: string; // nome do recebedor (max 25 chars no BR Code)
  city: string; // cidade (max 15 chars)
  amount: number; // valor em BRL
  description?: string; // opcional
  txid?: string; // opcional: id da transação
};

export async function generatePix(input: PixInput) {
  const qr = QrCodePix({
    version: "01",
    key: input.key,
    name: input.name.slice(0, 25),
    city: input.city.slice(0, 15),
    message: input.description?.slice(0, 25),
    value: Number(input.amount.toFixed(2)),
    transactionId: input.txid || "WPPBOT" + Date.now(),
  });

  const payload = qr.payload();
  const dataUrl = await qr.base64();
  return { payload, dataUrl };
}
