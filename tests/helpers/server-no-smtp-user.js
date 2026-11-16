// Test-only entry point: the real server, but with a mailer that can send while there is no SMTP_USER address. With
// real settings that cannot happen (the mailer is only on when SMTP_USER and SMTP_PASS are both set), so this is the
// only way to reach the "no recipient" answers. The stub transport sends nothing anywhere.
// Run it through tests/helpers/server.js ({ entry }), which sets the temp DB_PATH, UPLOAD_DIR and RECEIPT_DIR.
const { assertIsolated } = await import('./isolation.js');
assertIsolated(process.env); // DB_PATH, UPLOAD_DIR and RECEIPT_DIR must all be temp paths
const { setMailer } = await import('../../backend/lib/payments.js');
const { createMailer } = await import('../../backend/lib/mailer.js');

setMailer(createMailer({ env: {}, transport: { sendMail: async () => ({}) } }));
await import('../../backend/index.js');
