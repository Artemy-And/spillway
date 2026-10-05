// Just enough SMTP to send a plain-text notification, on Node's own net and tls: STARTTLS or
// implicit TLS, AUTH PLAIN, one message per connection.
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { hostname } from 'node:os';
import tls from 'node:tls';

export interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

interface Reply {
  code: number;
  lines: string[];
}

/** "Spillway <ops@acme.com>" → "ops@acme.com" */
export const addressOf = (mailbox: string) => mailbox.match(/<([^>]+)>/)?.[1] ?? mailbox.trim();

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Non-ASCII headers as RFC 2047 encoded words. */
const header = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;

export function formatMail(mail: Mail, now = new Date()): string {
  const body = Buffer.from(mail.text.replace(/\r?\n/g, '\r\n'))
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n');
  const domain = addressOf(mail.from).split('@')[1] ?? 'spillway.local';
  return [
    `From: ${header(mail.from)}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${header(mail.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** Reads whole replies ("250-…" lines up to "250 …") off a socket that can be swapped for TLS. */
class Session {
  #socket: net.Socket;
  #buffer = '';
  #lines: string[] = [];
  #replies: Reply[] = [];
  #waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  #failure: Error | null = null;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    this.#attach(socket);
  }

  #attach(socket: net.Socket) {
    // No setEncoding: after STARTTLS the TLS layer needs the raw bytes of this socket.
    const decoder = new TextDecoder();
    socket.on('data', (chunk: Buffer) => this.#feed(decoder.decode(chunk, { stream: true })));
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('The mail server closed the connection')));
  }

  #feed(chunk: string) {
    this.#buffer += chunk;
    let end = this.#buffer.indexOf('\r\n');
    while (end >= 0) {
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      this.#lines.push(line.slice(4));
      if (line[3] !== '-') {
        const reply = { code: Number(line.slice(0, 3)), lines: this.#lines };
        this.#lines = [];
        if (this.#waiting) {
          this.#waiting.resolve(reply);
          this.#waiting = null;
        } else this.#replies.push(reply);
      }
      end = this.#buffer.indexOf('\r\n');
    }
  }

  #fail(error: Error) {
    this.#failure ??= error;
    this.#waiting?.reject(error);
    this.#waiting = null;
  }

  read(): Promise<Reply> {
    const ready = this.#replies.shift();
    if (ready) return Promise.resolve(ready);
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  /** Sends a command and checks the reply code. */
  async command(line: string, expect: number[], shown = line): Promise<Reply> {
    this.#socket.write(`${line}\r\n`);
    const reply = await this.read();
    if (!expect.includes(reply.code)) {
      throw new Error(`Mail server refused ${shown}: ${reply.code} ${reply.lines.join(' ')}`);
    }
    return reply;
  }

  async startTls(host: string): Promise<void> {
    this.#socket.removeAllListeners('data');
    this.#socket.removeAllListeners('close');
    this.#socket.removeAllListeners('error');
    const secure = tls.connect({ socket: this.#socket, servername: host });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    });
    this.#socket = secure;
    this.#attach(secure);
  }

  close() {
    this.#socket.removeAllListeners('close');
    this.#socket.end();
  }
}

/** Sends one message through the server in `url` (smtp:// or smtps://). */
export async function sendMail(url: string, mail: Mail, timeoutMs = 20_000): Promise<void> {
  const server = new URL(url);
  const implicitTls = server.protocol === 'smtps:';
  const host = server.hostname;
  const port = Number(server.port) || (implicitTls ? 465 : 587);
  const user = decodeURIComponent(server.username);
  const password = decodeURIComponent(server.password);

  const socket = implicitTls
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('The mail server did not answer')));
  const session = new Session(socket);
  try {
    let secure = implicitTls;
    if ((await session.read()).code !== 220) throw new Error('The mail server did not greet us');
    const me = hostname() || 'spillway';
    let hello = await session.command(`EHLO ${me}`, [250]);
    if (!secure && hello.lines.some((line) => line.toUpperCase().startsWith('STARTTLS'))) {
      await session.command('STARTTLS', [220]);
      await session.startTls(host);
      secure = true;
      hello = await session.command(`EHLO ${me}`, [250]);
    }
    if (user) {
      if (!secure && !LOOPBACK.has(host)) {
        throw new Error(`${host} offers no TLS; Spillway will not send the password in the clear`);
      }
      const token = Buffer.from(`\0${user}\0${password}`).toString('base64');
      await session.command(`AUTH PLAIN ${token}`, [235], 'the user name or password');
    }
    await session.command(`MAIL FROM:<${addressOf(mail.from)}>`, [250]);
    for (const to of mail.to) await session.command(`RCPT TO:<${addressOf(to)}>`, [250, 251]);
    await session.command('DATA', [354]);
    await session.command(`${formatMail(mail)}\r\n.`, [250], 'the message');
    await session.command('QUIT', [221]).catch(() => {});
  } finally {
    session.close();
  }
}
