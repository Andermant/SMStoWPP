const path = require("path");
const pino = require("pino");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const config = require("../../config");
const contactsService = require("./contacts");
const { sendSMS } = require("./sms");

let sock = null;
const readline = require("readline");

const question = (text) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(text, (ans) => { rl.close(); resolve(ans); }));
};

function getSocket() {
  return sock;
}

async function startWhatsApp() {
  const authPath = path.join(config.dataDir, "auth_info");
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false
  });

  if (!sock.authState.creds.registered) {
    console.log("\n--- CONFIGURAÇÃO INICIAL DO WHATSAPP ---");
    const phoneNumber = await question("Digite o número do WhatsApp deste celular (ex: 5511999999999): ");
    
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber.trim().replace(/\D/g, ""));
        console.log(`\n========================================`);
        console.log(`CÓDIGO DE EMPARELHAMENTO: ${code}`);
        console.log(`========================================\n`);
        console.log("Abra o WhatsApp > Aparelhos Conectados > Conectar Aparelho > Conectar com número de telefone.");
      } catch (err) {
        console.error("Erro ao solicitar código:", err);
      }
    }, 4000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("[WhatsApp] Conexão fechada. Reconectando...", shouldReconnect);
      if (shouldReconnect) startWhatsApp();
    } else if (connection === "open") {
      console.log("[WhatsApp] Conectado com sucesso!");
      await contactsService.resolveAllLids(sock);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // WHATSAPP -> SMS
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const messageBody = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!messageBody) continue;

      let contact = contactsService.getByLid(remoteJid);

      if (!contact && remoteJid.endsWith("@s.whatsapp.net")) {
        const senderPhone = remoteJid.replace("@s.whatsapp.net", "");
        contact = contactsService.getByPhone(senderPhone);
      }

      if (contact) {
        console.log(`[WhatsApp -> SMS] Mensagem de @${contact.name}: ${messageBody}`);
        await sendSMS(config.authorizedNumber, `@${contact.name}: ${messageBody}`);
      }
    }
  });
}

module.exports = {
  startWhatsApp,
  getSocket
};