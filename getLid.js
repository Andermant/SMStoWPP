
const path = require("path");
const readline = require("readline");
const pino = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const AUTH_PATH = path.join(__dirname, "data", "auth_info");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = text =>
  new Promise(resolve => rl.question(text, resolve));

function normalizePhone(input) {
  const number = input.replace(/\D/g, "");

  if (!number || number.length < 8) {
    throw new Error("Número inválido.");
  }

  return number + "@s.whatsapp.net";
}

async function start() {
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_PATH);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      console.log("\nWhatsApp conectado!\n");

      while (true) {
        const input = await question("Telefone > ");

        if (input.trim().toLowerCase() === "sair") break;

        try {
          const pn = normalizePhone(input);

          const lid = await sock.signalRepository
            .lidMapping.getLIDForPN(pn);

          if (lid) {
            console.log("\nLID encontrado:");
            console.log(lid);
          } else {
            console.log("\nNenhum LID encontrado para esse número.");
          }
        } catch (error) {
          console.log("Erro:", error.message);
        }

        console.log("");
      }

      rl.close();
      sock.end(undefined);
      process.exit(0);
    }

    if (connection === "close") {
      const status = lastDisconnect?.error?.output?.statusCode;

      console.log("Conexão encerrada:", status);

      if (status === DisconnectReason.loggedOut) {
        console.log("Sessão desconectada.");
      }

      process.exit(1);
    }
  });
}

start().catch(console.error);
