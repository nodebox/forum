import type { Bindings } from "./env.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Send an email. `MAILER=cloudflare` sends through Cloudflare Email Sending
 * (the `EMAIL` send_email binding); `MAILER=log` prints it to the console,
 * for development.
 */
export async function sendMail(env: Bindings, mail: Mail): Promise<void> {
  if (env.MAILER === "cloudflare") {
    await env.EMAIL.send({ from: env.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    return;
  }
  console.log(`\n--- mail to ${mail.to}: ${mail.subject}\n${mail.text}\n---\n`);
}
