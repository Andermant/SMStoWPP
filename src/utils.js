const fs = require("fs");

function normalizeNumber(number) {
  return String(number || "").replace(/\D/g, "");
}

function getMessageId(message) {
  if (message._id !== undefined) return String(message._id);
  return [message.number, message.received || message.date, message.body].join("|");
}

function loadJson(filePath, defaultValue) {
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      console.log(`[Aviso] Arquivo corrompido ou inválido: ${filePath}. Usando padrão.`);
    }
  }
  return defaultValue;
}

function saveJson(filePath, data) {
  const dir = filePath.substring(0, filePath.lastIndexOf('/')) || filePath.substring(0, filePath.lastIndexOf('\\'));
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempFile = filePath + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, filePath);
}

module.exports = {
  normalizeNumber,
  getMessageId,
  loadJson,
  saveJson
};