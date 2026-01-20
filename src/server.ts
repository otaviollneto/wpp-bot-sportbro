import "dotenv/config";
import express from "express";
import multer from "multer";
import { initWA, getQR, onMessage, sendText, sendImageBuffer } from "./wa";
import { handleMessage } from "./bot";
import { sendPix } from "./media";
import { parse } from "csv-parse/sync";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// helper simples de delay
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Multer em memória (usando upload.any())
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 5,
  },
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/status", (_, res) => res.json({ status: getQR().status }));

app.get("/qr", (_, res) => {
  const { status, dataUrl } = getQR();
  if (status === "NEEDS_QR" && dataUrl) return res.json({ status, dataUrl });
  return res.json({ status });
});

app.get("/qr.png", (_, res) => {
  const { status, dataUrl } = getQR();
  if (status !== "NEEDS_QR" || !dataUrl) return res.status(204).end();
  const base64 = dataUrl.split(",")[1];
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.end(Buffer.from(base64, "base64"));
});

app.post("/send-text", async (req, res) => {
  const { to, message } = req.body;
  try {
    const r = await sendText(to, message);
    res.json({ id: r.id.id, ack: r.ack });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/send-pix", async (req, res) => {
  const { to, amount, description } = req.body;
  try {
    await sendPix(to, Number(amount), description);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /send-text-img-multi-csv
 * multipart/form-data
 * - csv           (file)  -> lista de destinatários
 * - image         (file)  -> imagem enviada pra todos
 * - message       (text)  -> texto; pode usar {{NOME}} se tiver coluna de nome
 * - columnPhone   (text)  -> nome da coluna de telefone (ex: "Telefone")
 * - columnName    (text)  -> opcional; nome da coluna de nome (ex: "Nome")
 * - dryRun        (text)  -> "true" para só simular envios
 * - minDelayMs    (text)  -> delay mínimo entre envios (ex: "2000")
 * - maxDelayMs    (text)  -> delay máximo entre envios (ex: "4000")
 * - batchSize     (text)  -> tamanho do lote (ex: "30")
 * - batchPauseMs  (text)  -> pausa entre lotes (ex: "600000" = 10 min)
 */
app.post("/send-text-img-multi-csv", upload.any(), async (req, res) => {
  try {
    const files = (req.files || []) as Express.Multer.File[];

    console.log("[send-text-img-multi-csv] body recebido:", req.body);
    console.log(
      "[send-text-img-multi-csv] files recebidos:",
      files.map((f) => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
      })),
    );

    const csvFile =
      files.find((f) => f.fieldname === "csv") ||
      files.find(
        (f) => f.mimetype.includes("csv") || f.originalname.endsWith(".csv"),
      );

    const imageFile =
      files.find((f) => f.fieldname === "image") ||
      files.find((f) => f.mimetype.startsWith("image/"));

    if (!csvFile) {
      return res.status(400).json({
        error:
          "Arquivo CSV não encontrado. Envie um campo de arquivo chamado 'csv' ou com mimetype 'text/csv'.",
      });
    }
    if (!imageFile) {
      return res.status(400).json({
        error:
          "Arquivo de imagem não encontrado. Envie um campo de arquivo chamado 'image' ou com mimetype de imagem.",
      });
    }

    let {
      message,
      columnPhone,
      columnName,
      dryRun,
      minDelayMs,
      maxDelayMs,
      batchSize,
      batchPauseMs,
    } = req.body as {
      message?: string;
      columnPhone?: string;
      columnName?: string;
      dryRun?: string;
      minDelayMs?: string;
      maxDelayMs?: string;
      batchSize?: string;
      batchPauseMs?: string;
    };

    if (!message) {
      return res.status(400).json({ error: "Campo 'message' é obrigatório" });
    }

    const isDryRun = String(dryRun).toLowerCase() === "true";

    // config de delay (ms)
    let minDelay = Number(minDelayMs);
    let maxDelay = Number(maxDelayMs);

    if (!Number.isFinite(minDelay) || minDelay < 0) minDelay = 2000; // 2s
    if (!Number.isFinite(maxDelay) || maxDelay < minDelay) {
      maxDelay = minDelay + 2000; // min + 2s
    }

    // config de lote
    let batchSizeNum = Number(batchSize);
    let batchPause = Number(batchPauseMs);

    if (!Number.isFinite(batchSizeNum) || batchSizeNum <= 0) {
      batchSizeNum = 0; // sem lote
    }
    if (!Number.isFinite(batchPause) || batchPause < 0) {
      batchPause = 0;
    }

    console.log(
      `[send-text-img-multi-csv] config: isDryRun=${isDryRun}, minDelay=${minDelay}, maxDelay=${maxDelay}, batchSize=${batchSizeNum}, batchPauseMs=${batchPause}`,
    );

    const buf = csvFile.buffer;

    const looksUtf16 =
      (buf[0] === 0xff && buf[1] === 0xfe) ||
      (buf[0] === 0xfe && buf[1] === 0xff) ||
      buf.slice(0, 100).includes(0);

    const csvText = looksUtf16 ? buf.toString("utf16le") : buf.toString("utf8");

    const rows: any[] = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    if (!rows.length) {
      return res.status(400).json({ error: "CSV sem linhas válidas" });
    }

    const headerCols = Object.keys(rows[0] || {});
    console.log("[send-text-img-multi-csv] colunas CSV:", headerCols);

    let phoneCol = columnPhone?.trim();
    if (!phoneCol) {
      const phoneCandidates = [
        "Telefone",
        "telefone",
        "Tel",
        "tel",
        "Celular",
        "celular",
        "Phone",
        "phone",
      ];
      phoneCol = headerCols.find((c) => phoneCandidates.includes(c));
    }

    if (!phoneCol) {
      return res.status(400).json({
        error:
          "Não foi possível determinar a coluna de telefone. Informe 'columnPhone' ou ajuste o cabeçalho do CSV.",
        headerCols,
      });
    }

    let nameCol = columnName?.trim();
    if (!nameCol) {
      const nameCandidates = ["Nome", "nome", "NomeCompleto", "nomeCompleto"];
      nameCol = headerCols.find((c) => nameCandidates.includes(c)) || "";
    }

    const imageBuffer = imageFile.buffer;
    const mimeType = imageFile.mimetype || "image/png";
    const filename = imageFile.originalname || "image";

    // remove números duplicados
    const uniqueRowsMap = new Map<string, any>();
    for (const row of rows) {
      const rawPhone = (row[phoneCol] || "").toString().trim();
      if (!rawPhone) continue;

      let digits = rawPhone.replace(/\D/g, "");
      if (digits.length === 11) {
        digits = "55" + digits;
      } else if (digits.length === 13 && digits.startsWith("55")) {
      } else if (!digits.startsWith("55")) {
        digits = "55" + digits;
      }

      if (!uniqueRowsMap.has(digits)) {
        uniqueRowsMap.set(digits, row);
      }
    }

    const uniqueRows = Array.from(uniqueRowsMap.values());
    console.log(
      `[send-text-img-multi-csv] removidos duplicados: ${rows.length} → ${uniqueRows.length}`,
    );

    console.log(
      `[send-text-img-multi-csv] processando: rowsUnique=${uniqueRows.length}, csv=${csvFile.originalname}, image=${imageFile.originalname}, columnPhone=${phoneCol}, columnName=${nameCol}, dryRun=${isDryRun}`,
    );

    const success: any[] = [];
    const failed: any[] = [];

    for (let index = 0; index < uniqueRows.length; index++) {
      const row = uniqueRows[index];
      try {
        const rawPhone = (row[phoneCol] || "").toString().trim();

        if (!rawPhone) {
          failed.push({ row, reason: "Telefone vazio" });
          continue;
        }

        let digits = rawPhone.replace(/\D/g, "");
        if (digits.length === 11) {
          digits = "55" + digits;
        } else if (digits.length === 13 && digits.startsWith("55")) {
        } else if (!digits.startsWith("55")) {
          digits = "55" + digits;
        }

        const nome = nameCol ? (row[nameCol] || "").toString().trim() : "";
        let finalMessage = message!;
        if (nome) {
          finalMessage = finalMessage.replace(/{{\s*NOME\s*}}/gi, nome);
        }

        if (isDryRun) {
          success.push({ phone: digits, simulated: true });
        } else {
          await sendText("+" + digits, finalMessage);
          await sendImageBuffer("+" + digits, imageBuffer, mimeType, filename);

          success.push({ phone: digits });

          const range = Math.max(maxDelay - minDelay, 0);
          const delay =
            minDelay + (range > 0 ? Math.floor(Math.random() * range) : 0);
          console.log(
            `[send-text-img-multi-csv] enviado para +${digits}, aguardando ${delay}ms...`,
          );
          await sleep(delay);

          if (
            batchSizeNum > 0 &&
            (index + 1) % batchSizeNum === 0 &&
            batchPause > 0
          ) {
            console.log(
              `[send-text-img-multi-csv] fim de lote (${
                index + 1
              } envios). Pausando ${batchPause}ms...`,
            );
            await sleep(batchPause);
          }
        }
      } catch (err: any) {
        console.error(
          `[send-text-img-multi-csv] erro ao enviar para linha ${index + 1}:`,
          err,
        );
        failed.push({ row, reason: err?.message || String(err) });
      }
    }

    res.json({
      ok: true,
      dryRun: isDryRun,
      totalCSV: rows.length,
      totalUnique: uniqueRows.length,
      successCount: success.length,
      failedCount: failed.length,
      success,
      failed,
    });
  } catch (err: any) {
    console.error("[send-text-img-multi-csv] erro:", err);
    res
      .status(500)
      .json({ error: "Erro interno: " + (err?.message || String(err)) });
  }
});

onMessage(async (msg) => {
  if (getQR().status !== "READY") {
    console.log("[WA] Ignorando msg: WA não está READY ainda.");
    return;
  }

  try {
    await handleMessage(msg);
  } catch (e) {
    console.error("[router] erro:", e);
  }
});

const port = Number(process.env.PORT || 8080);

(async () => {
  try {
    if (process.env.USE_WA === "true") {
      initWA().catch((err) => {
        console.error("[bootstrap] falha ao iniciar WA:", err);
      });
    }
    app.listen(port, "0.0.0.0", () => console.log("HTTP on", port));
  } catch (err) {
    console.error("[bootstrap] falha ao iniciar app HTTP:", err);
    process.exit(1);
  }
})();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
