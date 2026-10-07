// Sends email over SMTP (any provider: Gmail, Outlook, Zoho, SendGrid, Brevo…).
// With no SMTP_URL it only logs, so demo mode and tests work without a mail server.
const config = require('./config');
const { customerTemplates, ownerAlert } = require('./emails');

function createMailer({ smtpUrl = process.env.SMTP_URL, from = config.emailFrom, ownerEmail = config.ownerEmail, replyTo = config.supportEmail, transport, baseUrl } = {}) {
  let transporter = transport || null;
  if (!transporter && smtpUrl) transporter = require('nodemailer').createTransport(smtpUrl);
  const sender = from || (config.storeName && replyTo ? `"${config.storeName.replace(/"/g, '')}" <${replyTo}>` : replyTo);

  async function send(to, message) {
    if (!transporter) {
      console.log(`[email not sent – SMTP_URL not set] to=${to} subject="${message.subject}"`);
      return { logged: true };
    }
    await transporter.sendMail({ from: sender, replyTo, to, ...message });
    return { sent: true };
  }

  return {
    configured: Boolean(transporter),
    ownerConfigured: Boolean(ownerEmail),
    sendCustomer(order, kind) {
      const template = customerTemplates[kind];
      if (!template) throw new Error(`Unknown email: ${kind}`);
      return send(order.customer.email, template(order, baseUrl));
    },
    // Owner messages are skipped (logged) until OWNER_EMAIL is set.
    sendOwner(message) {
      if (!ownerEmail) {
        console.log(`[owner email skipped – OWNER_EMAIL not set] ${message.subject}`);
        return Promise.resolve({ logged: true });
      }
      return send(ownerEmail, message);
    },
    ownerAlert,
  };
}

module.exports = { createMailer };
