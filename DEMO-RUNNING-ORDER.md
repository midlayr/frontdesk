# Front Desk · demo running order

For presenting from, not for handing out. Roughly 20 minutes plus questions.

**Two windows, side by side.** Left: the rep app, Inbox tab, signed in.
Right: `…/demo`, the customer's view. You will move between them constantly, and
alt-tabbing in front of people reads as fumbling.

| | |
|---|---|
| Rep app | https://dumont-frontdesk.matt-dee.workers.dev |
| Customer view | https://dumont-frontdesk.matt-dee.workers.dev/demo |

---

## Before they arrive · 10 minutes

- [ ] Sign in. Leave the Inbox open on **All**.
- [ ] Load the demo data if it is not already there (`scripts/demo-reset.sql`). Nine tickets.
- [ ] Open `/demo` and **hard-refresh** (Cmd+Shift+R) — `w.js` is edge-cached.
- [ ] Play the ABC Plastics voicemail once. Confirm you hear it and your volume is up.
- [ ] Run the chat once, end to end, to see today's wording. **Then reload the demo data**,
      so the queue is clean and you are not demoing against your own test ticket.
- [ ] Silence notifications on both machines.

**Know these two numbers.** They are the ones you will be asked for.

- Nine tickets in the queue, six live, three won history
- $3,820 quoted and open — $3,180 Cascade, $640 Harbor Point

---

## 1 · The problem, in their words · 2 min

Do not open the app yet.

> "A quote request reaches you four ways — someone rings, someone texts, someone emails
> artwork, someone fills in the form on your site. Three of those live in one person's
> inbox or phone. When they are out, the job waits. When it is busy, something gets missed
> and nobody knows it was missed."

Ask: **"Where do yours actually arrive?"** Their answer tells you which part of the next
fifteen minutes to lean on. Write it down in front of them.

---

## 2 · One queue · 3 min

Rep app, Inbox. Do not click anything yet — let them read it.

> "Every one of those four ways lands here. Same list, same shape, whoever is on today."

Point at the channel icons down the left. Then:

- **The rush job at the top** — Ridgeline, trail map posters, event on the 4th. It is top
  of the list because it is rush, not because it is newest.
- **The ages.** "Quoted" tells you nothing. "Quoted, 9 days" tells a rep to pick up the
  phone. That is the Harbor Point recall postcards.

Do not tour the whole screen. Two things, then move.

---

## 3 · The voicemail · 4 min — **the centrepiece**

Open **ABC Plastics · Warehouse labels**. This is the strongest four minutes you have.
Slow down here.

**Press play.** Let it run — it is fifteen seconds. Say nothing over it.

Then point at the specs beside it, without hurrying:

> "Nobody typed any of this. It heard the call, wrote it out, and pulled the job out of it.
> Six thousand, four by six, matte."

Then the part that matters more:

> "And it has not guessed the stock. She said she was not certain, so it left it blank and
> flagged it. It would rather tell you it does not know than put something plausible in the
> box."

That distinction — *marked unknown* rather than *quietly filled* — is the thing a print
shop should care about, and it is what separates this from a transcription toy.

Then the history, one line: three warehouse label jobs, about 88 days apart, and the
company flagged as due.

> "It learned her rhythm from her own orders. One order would not be a rhythm, and it does
> not pretend otherwise."

---

## 4 · Live, on their website · 4 min

Switch to `/demo`. Let them see it is an ordinary web page with a chat bubble.

> "This is the shop's own site. One line of script, no plugin."

Run the quote flow. Answer as a customer would, and **type something slightly awkward**
rather than only tapping the chips — it is more honest and it still works.

When the ticket is created, **switch to the Inbox and let them watch it appear.** Do not
narrate the arrival. Just let it land.

That silence is the most persuasive moment in the demo. Use it.

---

## 5 · Replying · 2 min

Back to a ticket. Cascade Brewing, can labels, quoted at $3,180.

> "Reps answer from here, on whichever channel it arrived on. The customer gets a text;
> the thread stays whole."

Then open the ABC Plastics voicemail again and point at the composer:

> "You cannot answer a recording, so a reply to a voicemail goes back as a text. It says so
> before you type."

Do **not** actually send during the demo — the demo contacts are unroutable fictional
numbers, and a failure here would cost you more than the point is worth.

---

## 6 · Follow-ups, switched off · 3 min

Campaigns tab. Lead with the fact that nothing is on.

> "This is built and deliberately switched off. Nothing goes to a customer until somebody
> here turns it on."

Then why:

> "Automated follow-ups are the easiest thing in a system like this to get wrong, so the
> stops were built first. It stops the moment anyone replies — that rule cannot be edited
> out. Nothing sends outside your hours. And if a message needs a number the ticket does
> not have, it holds rather than sending 'Hi ,' to a customer."

Show the Harbor Point postcards — quoted, nine days quiet — as the thing a campaign would
chase. Ask whether they would want that on. Their hesitation is useful information.

---

## 7 · Theirs, not ours · 1 min

Settings → Appearance. Their colours, already applied.

> "Every shop on this platform gets its own. This is yours."

Thirty seconds. Do not linger.

---

## 8 · What is not built · 2 min — **do not skip this**

Say it before they find it.

> "You can mark a job Quoted and Won, but there is nowhere yet to record **how much**.
> Revenue reads zero until that exists. It is the next thing we would build, and it is what
> makes every other number mean something."

Also: no customer history page yet, no bulk list import, no website form.

Told up front this reads as a roadmap. Discovered by them, it reads as a surprise. It is
the same information either way — only the order changes how it lands.

---

## 9 · What we need · 2 min

1. **Start forwarding enquiries** to the intake address. Even a few by hand.
2. **A decision on open tracking** — needed for "opened but did not reply", and it is a
   judgement about their customers, not a technical one. Left off deliberately.
3. **Who needs an account**, and Sales or Admin for each.
4. **Text messages** — the number needs its own carrier registration. Days of paperwork,
   blocks nothing today.

---

## If something breaks

| What | Do |
|---|---|
| Voicemail will not play | Skip it, read the transcript aloud. Do not debug in the room. |
| Chat does not connect | Hard-refresh. Once. Then move to the seeded chat ticket and carry on. |
| A text does not arrive | Say the number is on a shared carrier registration awaiting its own — true, and boring enough to move past. |
| Something 500s | "That is a bug, I will have it tomorrow." Write it down where they can see. Do not open DevTools. |

**The rule:** never debug in front of them. A calm skip costs nothing. Two minutes of
squinting at a console costs the meeting.

---

## The one line to land

If they remember nothing else:

> **"Nothing reaches you and sits there unseen any more."**

Everything in this demo is a version of that sentence.
