const path = require("path");

const DATA_DIR = path.join(__dirname, "data");

module.exports = {
  authorizedNumber: "5511999999999", // Número do seu telefone (com DDI e DDD)
  pollInterval: 5000,                // Intervalo de verificação da caixa de entrada do SMS (ms)
  dataDir: DATA_DIR,
  stateFile: path.join(DATA_DIR, "processed.json"),
  contactsFile: path.join(DATA_DIR, "contacts.json")
};