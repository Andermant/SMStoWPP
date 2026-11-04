const fs = require("fs");
const config = require("../../config");
const { normalizeNumber, loadJson, saveJson } = require("../utils");

class ContactsService {
  constructor() {
    this.contacts = {}; // Formato: { apelido: { name, phone, lid } }
    this.load();
  }

  load() {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }
    const raw = loadJson(config.contactsFile, {});
    
    // Se o formato antigo for plano (ex: { joao: "5511..." }), converte automaticamente
    this.contacts = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        this.contacts[key.toLowerCase()] = {
          name: key.toLowerCase(),
          phone: normalizeNumber(value),
          lid: null
        };
      } else {
        this.contacts[key.toLowerCase()] = {
          name: value.name || key.toLowerCase(),
          phone: normalizeNumber(value.phone),
          lid: value.lid || null
        };
      }
    }
    this.save();
  }

  save() {
    saveJson(config.contactsFile, this.contacts);
  }

  getAll() {
    return this.contacts;
  }

  getByAlias(alias) {
    return this.contacts[alias.toLowerCase()] || null;
  }

  getByLid(lid) {
    return Object.values(this.contacts).find(c => c.lid === lid) || null;
  }

  getByPhone(phone) {
    const clean = normalizeNumber(phone);
    return Object.values(this.contacts).find(c => normalizeNumber(c.phone) === clean) || null;
  }

  async addOrUpdate(alias, phone, sock) {
    const cleanAlias = alias.toLowerCase().replace(/^@/, "");
    const cleanPhone = normalizeNumber(phone);
    
    let lid = null;
    if (sock) {
      try {
        const pnJid = `${cleanPhone}@s.whatsapp.net`;
        lid = await sock.signalRepository.lidMapping.getLIDForPN(pnJid);
      } catch (err) {
        console.error(`[Contacts] Erro ao buscar LID para ${cleanPhone}:`, err.message);
      }
    }

    this.contacts[cleanAlias] = {
      name: cleanAlias,
      phone: cleanPhone,
      lid: lid || this.contacts[cleanAlias]?.lid || null
    };

    this.save();
    return this.contacts[cleanAlias];
  }

  remove(alias) {
    const cleanAlias = alias.toLowerCase().replace(/^@/, "");
    if (this.contacts[cleanAlias]) {
      delete this.contacts[cleanAlias];
      this.save();
      return true;
    }
    return false;
  }

  async resolveAllLids(sock) {
    console.log("[Contacts] Atualizando LIDs de todos os contatos...");
    for (const [alias, contact] of Object.entries(this.contacts)) {
      if (!contact.phone) continue;
      try {
        const pnJid = `${contact.phone}@s.whatsapp.net`;
        const lid = await sock.signalRepository.lidMapping.getLIDForPN(pnJid);
        if (lid) {
          contact.lid = lid;
          console.log(`[Mapeamento] Contato @${alias} (${contact.phone}) -> LID: ${lid}`);
        } else {
          console.log(`[Mapeamento] Nenhum LID encontrado para @${alias} (${contact.phone}).`);
        }
      } catch (err) {
        console.error(`[Mapeamento] Erro ao buscar LID para @${alias}:`, err.message);
      }
    }
    this.save();
  }
}

module.exports = new ContactsService();