import { generatePix } from "./pix";
import { sendImageBase64, sendText } from "./wa.baileys";

export async function sendPix(
  toE164: string,
  amount: number,
  description?: string,
) {
  const { payload, dataUrl } = await generatePix({
    key: process.env.PIX_KEY!,
    name: process.env.PIX_MERCHANT!,
    city: process.env.PIX_CITY!,
    amount,
    description: description || process.env.PIX_DESCRIPTION,
  });

  await sendText(toE164, `Segue seu QR PIX (R$ ${amount.toFixed(2)}):`);
  await sendImageBase64(toE164, dataUrl, "pix.png", "QR Code PIX");
  // opcional: também enviar o payload copiável
  await sendText(toE164, payload);
}
