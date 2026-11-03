const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs"); // manipulação de arquivos e caminho de pastas
const path = require("path");
const readline = require("readline");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");

const exec = promisify(execFile);

// ================= CONFIGURAÇÕES =================
const CONFIG = {
  // Número do seu BlackBerry (com DDI e DDD, apenas números)
  authorizedNumber: "5511999999999",

  // Intervalo de consulta à caixa de entrada do SMS (milissegundos)
  pollInterval: 5000,

  // Mapeamento de apelidos para os números de WhatsApp (com DDI e DDD)
  contacts: {
    joao: "5511988888888",
    maria: "5511977777777"
  }
};
// ==================================================

const DATA_DIR = path.join(__dirname, "data"); // guarda o caminho absoluto de uma pasta data
const STATE_FILE = path.join(DATA_DIR, "processed.json"); 

let processed = new Set();
let initialized = false;
let polling = false;
let sock = null;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

function normalizeNumber(number) {
  return String(number || "").replace(/\D/g, "");
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    try {
      processed = new Set(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
    } catch {
      console.log("Aviso: estado inválido. Iniciando novamente.");
    }
  }
}

function saveState() {
  const data = JSON.stringify([...processed].slice(-5000));
  fs.writeFileSync(STATE_FILE + ".tmp", data);
  fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
}

async function sendSMS(number, message) {
  try {
    await exec("termux-sms-send", ["-n", number, message]);
    console.log(`[SMS Enviado] Para ${number}: ${message}`);
  } catch (err) {
    console.error("[Erro SMS] Falha ao enviar:", err.message);
  }
}

async function getInbox() {
  const { stdout } = await exec("termux-sms-list", ["-t", "inbox", "-l", "50"]);
  return JSON.parse(stdout);
}

function getMessageId(message) {
  if (message._id !== undefined) return String(message._id);
  return [message.number, message.received || message.date, message.body].join("|");
}

// ================= WHATSAPP (BAILEYS) =================
async function startWhatsApp() {
  const authPath = path.join(DATA_DIR, "auth_info");
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

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("[WhatsApp] Conexão fechada. Reconectando...", shouldReconnect);
      if (shouldReconnect) startWhatsApp();
    } else if (connection === "open") {
      console.log("[WhatsApp] Conectado com sucesso!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // WHATSAPP -> SMS (Manda de volta formatado para o BlackBerry)
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      console.log("[WhatsApp Debug] Mensagem crua recebida de:", msg.key.remoteJid);
      
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid.endsWith("@s.whatsapp.net")) continue;

      const senderPhone = remoteJid.replace("@s.whatsapp.net", "");
      const messageBody = msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (!messageBody) continue;

      let contactAlias = Object.keys(CONFIG.contacts).find(
        key => CONFIG.contacts[key] === senderPhone
      );

      if (contactAlias) {
        console.log(`[WhatsApp -> SMS] Mensagem de @${contactAlias}: ${messageBody}`);
        await sendSMS(CONFIG.authorizedNumber, `@${contactAlias}: ${messageBody}`);
      }
    }
  });
}

// ================= PROCESSAMENTO DE SMS =================
async function handleSMSMessage(message) {
  const sender = message.number;
  const body = String(message.body || "").trim();

  if (!sender || !body) return;

  const cleanSender = normalizeNumber(sender);
  const cleanAuthorized = normalizeNumber(CONFIG.authorizedNumber);
  
  //compara o numero do sms recebido com o numero autorizado
  if (!cleanSender.endsWith(cleanAuthorized.slice(-11))) {
    console.log(`[SMS Ignorado] Remetente não autorizado (${sender})`);
    return;
  }

  console.log(`[SMS Recebido] ${body}`);

  if (body === "!ajuda") {
    await sendSMS(sender, "Bridge: !status, @apelido mensagem");
    return;
  }

  if (body === "!status") {
    const wppStatus = sock?.user ? "conectado" : "desconectado";
    await sendSMS(sender, `Bridge online. WhatsApp: ${wppStatus}`);
    return;
  }

  const match = body.match(/^@([a-zA-Z0-9_-]+)\s+(.+)$/s);

  if (match) {
    const alias = match[1].toLowerCase();
    const messageText = match[2];
    const targetNumber = CONFIG.contacts[alias];

    if (!targetNumber) {
      await sendSMS(sender, `Contato desconhecido: @${alias}`);
      return;
    }

    if (!sock?.user) {
      await sendSMS(sender, "Erro: WhatsApp desconectado.");
      return;
    }

    try {
      const jid = `${targetNumber}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text: messageText });
      
      console.log(`[WhatsApp Enviado] Para @${alias}: ${messageText}`);
      await sendSMS(sender, `[Enviado @${alias}] OK`);
    } catch (err) {
      console.error("Erro ao enviar pelo WhatsApp:", err);
      await sendSMS(sender, `Erro ao enviar para @${alias}.`);
    }
    return;
  }

  await sendSMS(sender, "Comando desconhecido. Envie !ajuda.");
}

async function pollSMS() {
  if (polling) return;
  polling = true;

  try {
    const messages = await getInbox();
    if (!Array.isArray(messages)) return;

    if (!initialized) {
      for (const message of messages) {
        processed.add(getMessageId(message));
      }
      initialized = true;
      saveState();
      console.log("[SMS] Caixa de entrada inicializada.");
      return;
    }

    const pending = messages
      .filter(message => !processed.has(getMessageId(message)))
      .reverse();

    for (const message of pending) {
      const id = getMessageId(message);
      try {
        await handleSMSMessage(message);
        processed.add(id);
        saveState();
      } catch (error) {
        console.error("Erro ao processar SMS pendente:", error.message);
      }
    }
  } catch (error) {
    console.error("Erro ao consultar SMS:", error.message);
  } finally {
    polling = false;
  }
}

function start() {
  loadState();

  console.log("==============================");
  console.log("   SMS-WHATSAPP BRIDGE v2.0   ");
  console.log("==============================");

  startWhatsApp();
  pollSMS();
  setInterval(pollSMS, CONFIG.pollInterval);
}

start();