import { parseEmail, readForward, stripQuoted, ticketFromSubject, isAutomated } from '../src/lib/email';
import { classify } from '../src/hooks/email';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

const mime = (headers: string, body: string) => `${headers.trim()}\n\n${body}`;

console.log('direct enquiry');
{
  const raw = mime(`From: Jane Doe <jane@acme.test>
To: quotes@dumontprinting.com
Subject: Banner quote
Message-ID: <a1@acme.test>`, `Hi, we need 3 vinyl banners, 3m x 1m. How soon?

Jane`);
  const m = await parseEmail(raw);
  eq('sender is the customer', m.from, { name: 'Jane Doe', email: 'jane@acme.test' });
  eq('not a forward', m.forwardedBy, null);
  eq('subject kept', m.subject, 'Banner quote');
  eq('message id captured', m.messageId, '<a1@acme.test>');
  eq('body intact', m.body.startsWith('Hi, we need 3 vinyl banners'), true);
}

console.log('gmail forward');
{
  const raw = mime(`From: Ray Dumont <ray@dumontprinting.com>
To: dumont@in.midlayr.app
Subject: Fwd: Banner quote
Message-ID: <f1@dumontprinting.com>`, `Can you take this one?

---------- Forwarded message ---------
From: Jane Doe <jane@acme.test>
Date: Fri, 19 Sep 2026 at 10:02
Subject: Banner quote
To: <quotes@dumontprinting.com>


Hi, we need 3 vinyl banners, 3m x 1m. How soon?`);
  const m = await parseEmail(raw);
  eq('customer is the ORIGINAL sender, not the colleague', m.from, { name: 'Jane Doe', email: 'jane@acme.test' });
  eq('forwarder recorded', m.forwardedBy?.email, 'ray@dumontprinting.com');
  eq('original subject, not "Fwd:"', m.subject, 'Banner quote');
  eq('body is the forwarded message', m.body, 'Hi, we need 3 vinyl banners, 3m x 1m. How soon?');
}

console.log('outlook forward');
{
  const raw = mime(`From: Ray Dumont <ray@dumontprinting.com>
To: dumont@in.midlayr.app
Subject: FW: Booklet pricing`, `-----Original Message-----
From: Sam Okafor <sam@northwind.test>
Sent: Friday, September 19, 2026 10:02 AM
To: quotes@dumontprinting.com
Subject: Booklet pricing

500 booklets, 16pp, saddle stitched.`);
  const m = await parseEmail(raw);
  eq('original sender found', m.from.email, 'sam@northwind.test');
  eq('body is the enquiry', m.body, '500 booklets, 16pp, saddle stitched.');
}

console.log('apple mail forward');
{
  const raw = mime(`From: Ray <ray@dumontprinting.com>
To: dumont@in.midlayr.app
Subject: Fwd: Business cards`, `Begin forwarded message:

From: Lee Park <lee@harbor.test>
Subject: Business cards
Date: 19 September 2026 at 10:02:11 BST
To: quotes@dumontprinting.com

250 cards, 16pt matte.`);
  const m = await parseEmail(raw);
  eq('original sender found', m.from.email, 'lee@harbor.test');
  eq('body is the enquiry', m.body, '250 cards, 16pt matte.');
}

console.log('reply with quoted history');
{
  const raw = mime(`From: Jane Doe <jane@acme.test>
To: dumont@in.midlayr.app
Subject: Re: [DL-2000] Banner quote
In-Reply-To: <out1@midlayr.app>
References: <a1@acme.test> <out1@midlayr.app>`, `Friday works, thanks.

On Fri, 19 Sep 2026 at 11:00, Dumont Printing <quotes@dumontprinting.com> wrote:
> We can have those ready Friday. Does that suit?
> --
> Dumont Printing`);
  const m = await parseEmail(raw);
  eq('quoted history removed', m.body, 'Friday works, thanks.');
  eq('in-reply-to kept for threading', m.inReplyTo, '<out1@midlayr.app>');
  eq('references kept', m.references.length, 2);
  eq('ticket read from the subject', m.ticketHint, 'DL-2000');
  eq('Re: stripped from subject', m.subject, 'Banner quote');
}

console.log('subject ticket parsing');
eq('bracketed', ticketFromSubject('Re: [DL-2046] hello'), 'DL-2046');
eq('bare', ticketFromSubject('about dl-2046'), 'DL-2046');
eq('absent', ticketFromSubject('just a question'), null);
eq('not a random number', ticketFromSubject('quote for 5000 flyers'), null);

console.log('quote stripping');
eq('outlook separator', stripQuoted('Yes please.\n\n-----Original Message-----\nFrom: x\nold'), 'Yes please.');
eq('underscore rule', stripQuoted('Yes please.\n\n____________________\nFrom: x'), 'Yes please.');
eq('trailing > lines', stripQuoted('Yes.\n> old\n> older'), 'Yes.');
eq('nothing to strip', stripQuoted('Just this.'), 'Just this.');

console.log('forward detection edge cases');
eq('no marker means no forward', readForward('Just a normal message, nothing quoted.'), null);
eq('marker without a From: is not a usable forward',
   readForward('---------- Forwarded message ---------\nno headers here'), null);

console.log('automated mail is ignored');
{
  const h = (map: Record<string, string>) => (n: string) => map[n.toLowerCase()] ?? null;
  eq('auto-submitted', isAutomated(h({ 'auto-submitted': 'auto-replied' })), true);
  eq('auto-submitted: no is a real person', isAutomated(h({ 'auto-submitted': 'no' })), false);
  eq('precedence bulk', isAutomated(h({ precedence: 'bulk' })), true);
  eq('bounce', isAutomated(h({ 'return-path': '<>' })), true);
  eq('mailing list', isAutomated(h({ 'list-unsubscribe': '<https://x/u>' })), true);
  eq('ordinary mail', isAutomated(h({ 'return-path': '<jane@acme.test>' })), false);
}

console.log('the loop guard, through the real parser');
{
  // Regression: the handler used to hand isAutomated a lookup that knew only message-id and
  // in-reply-to, so every guard below silently saw null and an out-of-office made a ticket.
  const ooo = await parseEmail(mime(`From: Jane Doe <jane@acme.test>
To: dumont@in.midlayr.app
Subject: Automatic reply: Banner quote
Auto-Submitted: auto-replied
Message-ID: <ooo@acme.test>`, 'I am out of the office until Monday.'));
  eq('out-of-office is recognised from a parsed message', isAutomated(ooo.header), true);

  const list = await parseEmail(mime(`From: News <news@vendor.test>
To: dumont@in.midlayr.app
Subject: September newsletter
List-Unsubscribe: <https://vendor.test/u>`, 'Our latest offers.'));
  eq('a newsletter is recognised', isAutomated(list.header), true);

  const real = await parseEmail(mime(`From: Jane Doe <jane@acme.test>
To: dumont@in.midlayr.app
Subject: Banner quote
Return-Path: <jane@acme.test>`, 'Can you quote 6 banners?'));
  eq('a real enquiry is not', isAutomated(real.header), false);
}

console.log('which way the message points');
{
  const team = new Map([['ray@dumontprinting.com', 'user_ray']]);
  const ours = new Set(['dumont@in.midlayr.app']);
  const base = {
    subject: 's', body: 'b', messageId: null, inReplyTo: null, references: [],
    ticketHint: null, attachments: [],
  };

  eq('customer writes in → inbound, customer is the sender',
     classify({ ...base, from: { name: 'Jane', email: 'jane@acme.test' }, forwardedBy: null,
                to: ['dumont@in.midlayr.app'] } as never, team, ours),
     { direction: 'in', customer: { name: 'Jane', email: 'jane@acme.test' }, agentId: null, note: null });

  eq('rep bccs an outgoing mail → outbound, customer is the recipient',
     classify({ ...base, from: { name: 'Ray', email: 'ray@dumontprinting.com' }, forwardedBy: null,
                to: ['jane@acme.test', 'dumont@in.midlayr.app'] } as never, team, ours),
     { direction: 'out', customer: { name: null, email: 'jane@acme.test' }, agentId: 'user_ray', note: null });

  eq('rep forwards → inbound, customer is the original sender',
     classify({ ...base, from: { name: 'Jane', email: 'jane@acme.test' },
                forwardedBy: { name: 'Ray', email: 'ray@dumontprinting.com' },
                to: ['dumont@in.midlayr.app'] } as never, team, ours),
     { direction: 'in', customer: { name: 'Jane', email: 'jane@acme.test' },
       agentId: 'user_ray', note: 'Forwarded by Ray' });

  eq('rep mails only us, no customer to point at → treated as inbound rather than guessed',
     classify({ ...base, from: { name: 'Ray', email: 'ray@dumontprinting.com' }, forwardedBy: null,
                to: ['dumont@in.midlayr.app'] } as never, team, ours).direction, 'in');
}

console.log('attachments');
{
  const raw = [
    'From: Jane Doe <jane@acme.test>',
    'To: dumont@in.midlayr.app',
    'Subject: Artwork',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BB"',
    '',
    '--BB',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Artwork attached.',
    '--BB',
    'Content-Type: application/pdf; name="banner.pdf"',
    'Content-Disposition: attachment; filename="banner.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 fake').toString('base64'),
    '--BB--',
    '',
  ].join('\n');
  const m = await parseEmail(raw);
  eq('one attachment', m.attachments.length, 1);
  eq('filename', m.attachments[0].filename, 'banner.pdf');
  eq('mime type', m.attachments[0].mimeType, 'application/pdf');
  eq('body still read', m.body, 'Artwork attached.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
