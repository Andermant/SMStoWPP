const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs"); 
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

  // Mapeamento de apelidos para os números de telefone (a partir dos quais descobriremos os LIDs)
  contacts: {
    joao: "5511988888888",
    maria: "5511977777777"
  }
};
// ==================================================

const DATA_DIR = path.join(__dirname, "data"); 
const STATE_FILE = path.join(DATA_DIR, "processed.json"); 

let processed = new Set();
let initialized = false;
let polling = false;
let sock = null;

// Armazenará a relação de apelido para o LID correspondente (ex: { joao: "123456@lid" })
let contactLids = {};

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

// Função para varrer os contatos e mapear números para LIDs
async function resolveContactLids() {
  console.log("[WhatsApp] Iniciando varredura e mapeamento de LIDs dos contatos...");
  contactLids = {};

  for (const [alias, phoneNumber] of Object.entries(CONFIG.contacts)) {
    try {
      const cleanPhone = normalizeNumber(phoneNumber);
      const pnJid = `${cleanPhone}@s.whatsapp.net`;
      
      // Descobre o LID usando o método nativo do Baileys
      const lid = await sock.signalRepository.lidMapping.getLIDForPN(pnJid);

      if (lid) {
        contactLids[alias] = lid;
        console.log(`[Mapeamento] Contato @${alias} (${cleanPhone}) -> LID: ${lid}`);
      } else {
        console.log(`[Mapeamento] Aviso: Nenhum LID encontrado para @${alias} (${cleanPhone}). O contato pode precisar de interagir antes.`);
      }
    } catch (err) {
      console.error(`[Mapeamento] Erro ao buscar LID para @${alias}:`, err.message);
    }
  }
  console.log("[WhatsApp] Mapeamento de LIDs concluído.");
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

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("[WhatsApp] Conexão fechada. Reconectando...", shouldReconnect);
      if (shouldReconnect) startWhatsApp();
    } else if (connection === "open") {
      console.log("[WhatsApp] Conectado com sucesso!");
      // Executa a varredura e mapeamento de LIDs assim que a conexão abre
      await resolveContactLids();
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // WHATSAPP -> SMS (Manda de volta formatado para o BlackBerry)
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid; // Pode vir como @lid ou @s.whatsapp.net
      console.log("[WhatsApp Debug] Mensagem crua recebida de:", remoteJid);

      const messageBody = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!messageBody) continue;

      // Verifica se o remoteJid recebido corresponde ao LID de algum contato mapeado
      let contactAlias = Object.keys(contactLids).find(
        key => contactLids[key] === remoteJid
      );

      // Fallback: se não achar por LID direto, tenta ver se bate com o final do número caso venha tradicional
      if (!contactAlias && remoteJid.endsWith("@s.whatsapp.net")) {
        const senderPhone = remoteJid.replace("@s.whatsapp.net", "");
        contactAlias = Object.keys(CONFIG.contacts).find(
          key => CONFIG.contacts[key] === senderPhone
        );
      }

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
    
    // Busca o LID atribuído previamente ao contato
    const targetLid = contactLids[alias];

    if (!targetLid) {
      await sendSMS(sender, `Contato desconhecido ou sem LID mapeado: @${alias}`);
      return;
    }

    if (!sock?.user) {
      await sendSMS(sender, "Erro: WhatsApp desconectado.");
      return;
    }

    try {
      // Envia diretamente usando o LID descoberto na varredura
      await sock.sendMessage(targetLid, { text: messageText });
      
      console.log(`[WhatsApp Enviado] Para @${alias} (LID: ${targetLid}): ${messageText}`);
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
  console.log("   SMS-WHATSAPP BRIDGE v2.1   ");
  console.log("==============================");

  startWhatsApp();
  pollSMS();
  setInterval(pollSMS, CONFIG.pollInterval);
}

start();