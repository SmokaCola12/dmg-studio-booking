// Email sender for payment updates (to customers) and studio notifications (to the staff inbox). No database import,
// so tests can load it alone.
//
// Settings come from the environment (names only here, values live in .env):
//   SMTP_USER, SMTP_PASS   the Gmail address and its App Password; email is skipped silently when either is missing
//   MAIL_FROM              sender shown to customers (default: SMTP_USER)
//   SMTP_HOST, SMTP_PORT   default smtp.gmail.com and 465 (secure)
//   PUBLIC_SITE_URL        optional; adds a link to the booking lookup page (customers) or the admin page (staff)
import nodemailer from 'nodemailer';

const STUDIO = 'DMG Studio';

function lookupLine(d) {
  return d.siteUrl
    ? `You can check your booking any time at ${d.siteUrl}/check with your booking code and mobile number.`
    : 'You can check your booking any time on the DMG Studio website with your booking code and mobile number.';
}

function holdRules(d) {
  return `A GCash booking holds its slot for ${d.holdMinutes} minutes while we wait for your receipt screenshot. Once a screenshot is uploaded, the slot is held until the studio checks the payment.`;
}

function bookingBlock(d) {
  return [`Booking code: ${d.code}`, `Studio: ${d.room}`, `When: ${d.when}`].join('\n');
}

// ---------- Staff emails ----------
// Every value arrives ready to print (see staffData in payments.js). Never the GCash QR text, a file name or the image.

function staffBlock(d) {
  return [
    `Booking code: ${d.code}`,
    `Status: ${d.status}`,
    '',
    `Customer: ${d.name}${d.band ? ` (${d.band})` : ''}`,
    `Phone: ${d.phone || 'not given'}`,
    d.email ? `Email: ${d.email}` : null,
    '',
    `Studio: ${d.room}`,
    `When: ${d.when}`,
    `Hours: ${d.hours}`,
    `Total: ${d.total}`,
    `Payment: ${d.payment}`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

const staffFooter = (d, label) => (d.adminUrl ? ['', `${label}: ${d.adminUrl}`] : []);

export const TEMPLATES = {
  staffNewBooking: (d) => ({
    subject: `New booking ${d.code} · ${d.when} · ${d.room}`,
    text: ['A customer made a new booking on the website.', '', staffBlock(d), ...staffFooter(d, 'Open the admin page')].join('\n'),
  }),
  staffPaymentProof: (d) => ({
    subject: `GCash receipt to check · ${d.code} · ${d.amount}`,
    text: [
      d.reupload
        ? `The customer uploaded another GCash receipt screenshot for ${d.amount}, after the last one was marked not received.`
        : `A customer uploaded a GCash receipt screenshot for ${d.amount}.`,
      'Check your GCash, then mark the payment as received or not received. The slot stays held until you do.',
      '',
      staffBlock(d),
      ...staffFooter(d, 'Check the receipt'),
    ].join('\n'),
  }),
  staffCustomerChange: (d) =>
    d.kind === 'rescheduled'
      ? {
          subject: `Booking ${d.code} rescheduled by customer · ${d.when}`,
          text: [
            'The customer moved this booking online.',
            '',
            `Was: ${d.oldWhen}`,
            `Now: ${d.when}`,
            '',
            staffBlock(d),
            ...staffFooter(d, 'Open the admin page'),
          ].join('\n'),
        }
      : {
          subject: `Booking ${d.code} cancelled by customer`,
          text: ['The customer cancelled this booking online. The slot is free again.', '', staffBlock(d), ...staffFooter(d, 'Open the admin page')].join('\n'),
        },
  test: (d) => ({
    subject: `${STUDIO}: test email`,
    text: [
      `This is a test email from the ${STUDIO} booking site.`,
      '',
      'If you can read this, booking notifications will reach this inbox.',
      ...staffFooter(d, 'Open the admin page'),
    ].join('\n'),
  }),
  confirmed: (d) => ({
    subject: `${STUDIO}: payment received, booking ${d.code} confirmed`,
    text: [
      `Hi ${d.name},`,
      '',
      `We received your GCash payment of PHP ${d.amount}, and your booking is confirmed.`,
      '',
      bookingBlock(d),
      d.balanceDue > 0 ? `\nBalance of PHP ${d.balanceDue} is paid at the studio (cash or GCash).` : '',
      '',
      lookupLine(d),
      '',
      `See you at ${STUDIO}!`,
    ].join('\n'),
  }),
  notReceived: (d) => ({
    subject: `${STUDIO}: we have not received your payment for ${d.code}`,
    text: [
      `Hi ${d.name},`,
      '',
      `We checked for your GCash payment of PHP ${d.amount} but have not received it yet. Your booking is still pending and the slot stays held for now.`,
      '',
      bookingBlock(d),
      '',
      'If you already paid, upload a clearer screenshot of your GCash receipt, or message the studio. If you have not paid yet, please send the payment so we can confirm your booking.',
      '',
      holdRules(d),
      lookupLine(d),
    ].join('\n'),
  }),
  holdExpired: (d) => ({
    subject: `${STUDIO}: your booking ${d.code} was released`,
    text: [
      `Hi ${d.name},`,
      '',
      `We did not receive a payment screenshot within ${d.holdMinutes} minutes, so the slot for this booking was released:`,
      '',
      bookingBlock(d),
      '',
      'If you already paid, please message the studio with your GCash receipt and we will sort it out. Otherwise you are welcome to book again on the website.',
      '',
      lookupLine(d),
    ].join('\n'),
  }),
};

/**
 * Creates a mailer. `transport` can be injected (tests). Without SMTP_USER and SMTP_PASS (and no injected transport)
 * `send` resolves to { skipped: true } and does nothing. `send` never throws and never logs addresses or credentials.
 */
export function createMailer({ env = process.env, transport } = {}) {
  const user = env.SMTP_USER || '';
  const pass = env.SMTP_PASS || '';
  let tx = transport || null;
  const enabled = !!tx || !!(user && pass);
  const from = env.MAIL_FROM || user || 'noreply@localhost';

  function getTransport() {
    if (tx) return tx;
    const port = Number(env.SMTP_PORT) || 465;
    // Timeouts keep a dead mail server from holding a send (or the admin's test email) open for minutes.
    tx = nodemailer.createTransport({
      host: env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    return tx;
  }

  return {
    enabled,
    /** The SMTP_USER address: the default inbox for staff emails. The password is never exposed. */
    user,
    async send(template, to, data) {
      if (!enabled || !to) return { skipped: true };
      const build = TEMPLATES[template];
      if (!build) return { skipped: true };
      try {
        const { subject, text } = build(data);
        await getTransport().sendMail({ from, to, subject, text });
        return { sent: true };
      } catch (err) {
        // Only the template name and the error code: never the address, message or credentials.
        console.error(`[mail] ${template} failed: ${err?.code || 'error'}`);
        return { sent: false, failed: true };
      }
    },
  };
}
