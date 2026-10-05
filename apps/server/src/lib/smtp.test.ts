import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { addressOf, formatMail, sendMail } from './smtp.ts';

// A mail server that takes AUTH PLAIN without TLS, as relays on localhost do.
const commands: string[] = [];
let message = '';
const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 mail.test ESMTP\r\n');
  let buffer = '';
  let inData = false;
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    while (true) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        message = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        socket.write('250 queued\r\n');
        continue;
      }
      const end = buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      commands.push(line);
      if (line.startsWith('EHLO'))
        socket.write('250-mail.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
      else if (line.startsWith('AUTH PLAIN ')) {
        const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
        socket.write(user === 'ops@acme.test' && pass === 's3cret' ? '235 ok\r\n' : '535 no\r\n');
      } else if (line.startsWith('MAIL') || line.startsWith('RCPT')) socket.write('250 ok\r\n');
      else if (line === 'DATA') {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (line === 'QUIT') {
        socket.write('221 bye\r\n');
        socket.end();
      }
    }
  });
});
let url = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `smtp://ops%40acme.test:s3cret@127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('sends a message with a UTF-8 subject and body', async () => {
  await sendMail(url, {
    from: 'Spillway <ops@acme.test>',
    to: ['anna@acme.test', 'Ben <ben@acme.test>'],
    subject: '[Spillway] Маркетинг over budget',
    text: 'Line one\nСтрока два',
  });
  assert.ok(commands.includes('MAIL FROM:<ops@acme.test>'));
  assert.ok(commands.includes('RCPT TO:<anna@acme.test>'));
  assert.ok(commands.includes('RCPT TO:<ben@acme.test>'));
  const [headers, body] = message.split('\r\n\r\n') as [string, string];
  const subject = headers.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)?.[1] ?? '';
  assert.equal(Buffer.from(subject, 'base64').toString(), '[Spillway] Маркетинг over budget');
  assert.equal(Buffer.from(body, 'base64').toString(), 'Line one\r\nСтрока два');
});

test('a wrong password is reported without echoing it', async () => {
  await assert.rejects(
    sendMail(url.replace('s3cret', 'nope'), {
      from: 'ops@acme.test',
      to: ['anna@acme.test'],
      subject: 'x',
      text: 'x',
    }),
    (error: Error) => /user name or password/.test(error.message) && !/nope/.test(error.message),
  );
});

test('long bodies are wrapped and addresses are pulled out of names', () => {
  const raw = formatMail({
    from: 'a@b.test',
    to: ['c@d.test'],
    subject: 's',
    text: 'x'.repeat(300),
  });
  const body = raw.split('\r\n\r\n')[1]!;
  assert.ok(body.split('\r\n').every((line) => line.length <= 76));
  assert.equal(addressOf('Ops Team <ops@acme.test>'), 'ops@acme.test');
});
