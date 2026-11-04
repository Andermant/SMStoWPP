const { execFile } = require("child_process");
const { promisify } = require("util");

const exec = promisify(execFile);

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

module.exports = {
  sendSMS,
  getInbox
};