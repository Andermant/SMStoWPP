const fs = require("fs");
const config = require("./config");
const { normalizeNumber, getMessageId, loadJson, saveJson } = require("./src/utils");
const { sendSMS, getInbox } = require("./src/services/sms");
const contactsService = require("./src/services/contacts");
const { startWhatsApp, getSocket } = require("./src/services/whatsapp");

let processed = new Set();
let initialized = false;
let polling = false;

function loadState() {
  if (fs.existsSync(config.dataDir)) {
    const data = loadJson(config.stateFile, []);
    processed = new Set(data);
  }
}

function saveState() {
  const data = JSON.stringify([...processed].slice(-5000));
  saveJson(config.stateFile, JSON.parse(data));
}

async function handleSMSMessage(message) {
  const sender = message.number;
  const body = String(message.body || "").trim();

  if (!sender || !body) return;

  const cleanSender = normalizeNumber(sender);
  const cleanAuthorized = normalizeNumber(config.authorizedNumber);
  
  if (!cleanSender.endsWith(cleanAuthorized.slice(-11))) {
    console.log(`[SMS Ignorado] Remetente não autorizado (${sender})`);
    return;
  }

  console.log(`[SMS Recebido] ${body}`);

  // Comando: !ajuda
  if (body === "!ajuda") {
    await sendSMS(sender, "Bridge: !status, !list, !add <nome> <tel>, !delete @<nome>, @<apelido> <msg>");
    return;
  }

  // Comando: !status
  if (body === "!status") {
    const sock = getSocket();
    const wppStatus = sock?.user ? "conectado" : "desconectado";
    await sendSMS(sender, `Bridge online. WhatsApp: ${wppStatus}`);
    return;
  }

  // Comando: !list
  if (body === "!list") {
    const all = contactsService.getAll();
    const entries = Object.values(all);
    if (entries.length === 0) {
      await sendSMS(sender, "Nenhum contato cadastrado.");
    } else {
      const listStr = entries.map(c => `@${c.name} ${c.phone}`).join("\n");
      await sendSMS(sender, `Contatos:\n${listStr}`);
    }
    return;
  }

  // Comando: !add nome númeroTelefone
  const addMatch = body.match(/^!add\s+([a-zA-Z0-9_-]+)\s+(.+)$/i);
  if (addMatch) {
    const alias = addMatch[1];
    const phone = addMatch[2];
    const sock = getSocket();

    const savedContact = await contactsService.addOrUpdate(alias, phone, sock);
    await sendSMS(sender, `Contato @${savedContact.name} (${savedContact.phone}) salvo com sucesso!`);
    return;
  }

  // Comando: !delete @nomeContato ou !delete nomeContato
  const deleteMatch = body.match(/^!delete\s+@?([a-zA-Z0-9_-]+)$/i);
  if (deleteMatch) {
    const alias = deleteMatch[1];
    const removed = contactsService.remove(alias);
    if (removed) {
      await sendSMS(sender, `Contato @${alias} removido com sucesso.`);
    } else {
      await sendSMS(sender, `Contato @${alias} não encontrado.`);
    }
    return;
  }

  // Encaminhamento para WhatsApp: @apelido mensagem
  const msgMatch = body.match(/^@([a-zA-Z0-9_-]+)\s+(.+)$/s);
  if (msgMatch) {
    const alias = msgMatch[1].toLowerCase();
    const messageText = msgMatch[2];
    const contact = contactsService.getByAlias(alias);

    if (!contact) {
      await sendSMS(sender, `Contato desconhecido: @${alias}. Use !add para cadastrar.`);
      return;
    }

    const sock = getSocket();
    if (!sock?.user) {
      await sendSMS(sender, "Erro: WhatsApp desconectado.");
      return;
    }

    try {
      // Se não tiver LID mapeado, tenta buscar na hora antes de enviar
      let targetLid = contact.lid;
      if (!targetLid && contact.phone) {
        const pnJid = `${contact.phone}@s.whatsapp.net`;
        targetLid = await sock.signalRepository.lidMapping.getLIDForPN(pnJid);
        if (targetLid) {
          await contactsService.addOrUpdate(alias, contact.phone, sock);
        }
      }

      const destination = targetLid || `${contact.phone}@s.whatsapp.net`;
      await sock.sendMessage(destination, { text: messageText });
      
      console.log(`[WhatsApp Enviado] Para @${alias} (${destination}): ${messageText}`);
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
  console.log("   SMStoWPP BRIDGE v0.0.2   ");
  console.log("==============================");

  startWhatsApp();
  pollSMS();
  setInterval(pollSMS, config.pollInterval);
}

start();