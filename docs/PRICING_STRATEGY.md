# Printlay — Pricing Strategy & Launch Playbook

_Last updated: 26 April 2026_

This doc is the single source of truth for **why** Printlay's pricing
looks the way it does, **how** the Founder Offer is structured, and the
**marketing levers** we have available without breaking the model. Hand
this to any future copywriter, growth hire or co-founder and they should
be able to act without asking.

---

## 1. TL;DR

| Plan       | Monthly | Annual (17% off) | Storage | PDF exports / mo | Per-file cap |
| ---------- | ------- | ---------------- | ------- | ---------------- | ------------ |
| Trial (14d)| free    | —                | 1 GB    | unlimited\*      | 100 MB       |
| Starter    | £25     | £250             | 5 GB    | 200              | 50 MB        |
| **Pro**    | **£49** | **£490**         | 50 GB   | unlimited        | 100 MB       |
| Studio     | £99     | £990             | 250 GB  | unlimited        | 500 MB       |
| Enterprise | call us | call us          | unlimited| unlimited       | 1 GB         |

\* Trial users get the Pro feature set, capped at 1 GB total storage.

**Launch promotion:** Founder Offer — `FOUNDERS50` — **50% off forever**
for any subscription started before midnight, **30 July 2026**.

**The offer is a percentage discount, not a price lock.** Future price
rises apply to founders too, just at half the new headline rate.
(See [§6 of the Terms](../frontend/src/pages/Terms.tsx).)

---

## 2. Why these numbers

### Three tiers, not four; four if you count Enterprise

The print SaaS buyer is a small business owner. Choice paralysis is
real and deadly. Three named tiers + a "call us" tier for invoiced deals
gives every shop a clear option to point at.

- **Starter** — solo print operators, side hustles, recently-launched
  shops. Their objection is _"I'm not sure I'll use it enough yet."_
  Starter answers: _"£25/mo, 200 exports, 5 GB. Stop worrying."_
- **Pro** — the actual product. The default. Marked **Most popular** on
  the cards. Working print shops with multiple SKUs, multiple operators
  and real volume should land here.
- **Studio** — production houses, multi-shift, white-label, API.
  Volume-driven shops who want to embed Printlay into their workflow.
- **Enterprise** — invoiced, multi-seat, custom storage. We don't show a
  price; "if you have to ask, you can afford it" is the right signal
  for this band.

### Why Pro is the gravity well

The whole pricing page should pull people toward Pro. Three signals:

1. The **Most popular** badge sits on Pro. (`most_popular: true` in
   `_PLAN_DISPLAY` in `backend/routers/billing.py`.)
2. The trial gives the Pro feature set, so when the trial ends
   "carrying on" feels like Pro, not Starter.
3. Starter has visible ceilings (5 templates, 200 exports, 5 GB) that
   feel small the moment a real shop scales. We're not punishing
   Starter; we're being honest about who it's for.

### Why £25 / £49 / £99 (and not £19 / £39 / £79)

We tested in copy:

- £19 felt too cheap for a B2B production tool — devalued the brand and
  signalled "hobbyist."
- £19 also gives no headroom for promotions. **£25 with a 50% Founder
  rate lands at £12.50** — that's a more compelling _claim_ than "£19,
  half-off £9.50" while letting us move headline pricing later.
- £49 / £99 land on the standard SaaS price ladder. Buyers will mentally
  bucket Printlay alongside other working-shop tools (£40–£100/mo) and
  not next to consumer creative apps (£10–£20/mo).

### Annual at 17%, not 20%

17% works out to two months free if you round generously. It's enough
to make annual feel like a bargain, but not so deep that it cannibalises
monthly cashflow during the launch period.

### Why no usage-based pricing

PDF generation costs us real CPU/RAM. We _did_ consider per-export
metering. We didn't ship it because:

- Print shops hate variable bills. They want to forecast.
- It would push every customer toward "minimise exports" — exactly the
  opposite of the engagement we want.
- The 200/month cap on Starter is enough to deter abuse and signal a
  natural Pro upgrade path.

We monitor exports server-side and rate-limit at 30/min on `/generate`
to keep a single account from cooking the box.

---

## 3. The Founder Offer

### Mechanics

- Coupon code: `FOUNDERS50` (auto-applied on the pricing page while the
  offer is live; users never see it unless they go looking).
- 50% off, **forever**, on any plan started before midnight (UK) on
  **30 July 2026**.
- Awarded a permanent **Founder badge** in the app (cosmetic, no
  separate entitlement).
- Discount survives plan changes — a Founder who upgrades Starter → Pro
  → Studio keeps 50% off at every tier.
- Discount does **not** stack with other promo codes.
- If the founder cancels and resubscribes after the offer closes, the
  discount does not reactivate.

### The unlock: percentage, not price

The Founder Offer is structured in the Terms (§6) as a **percentage
discount off the published price at the time of each renewal**. This is
deliberate. It means:

- We can move headline pricing up over time without legal exposure.
- Founders continue to get 50%, just on the new headline price.
- A Founder paying £12.50 today will pay £14.50 if Starter goes to £29
  next year. That's still less than any non-Founder will pay, and we
  retain pricing power as the product matures.

We chose this over a price lock because, fundamentally, software gets
better. Locking the 2026 price forever would mean the most engaged
customers — the ones who stuck around for years — would be paying the
least for the most-improved version. That's the wrong way around.

### Why 30 July (not 30 June, not "first 50 shops")

- "First 50 shops" is invisible — buyers don't know how many seats are
  left, can't plan around it, and feel manipulated when they find out
  the counter was symbolic.
- 30 June was too tight. With a 14-day trial, anyone signing up in mid
  June had to evaluate the product in a fortnight or lose the offer.
- 30 July gives us a full quarter of runway from the date this doc was
  written, time for one content cycle, and a final-week push.
- "Until midnight, 30 July 2026" is the longest a credible Founder
  promo should run. Past 90 days, the urgency thins.

### Why we'll never extend it again

We will say "30 July 2026, no second chances" in copy and we will mean
it. If we extend a second time:

- Conversions on the final week collapse (the deadline becomes folklore).
- Word-of-mouth founders who paid feel suckered.
- Future scarcity tactics (Black Friday, anniversary) won't work.

If we genuinely under-fill, we'll run a separate, smaller _post-Founder_
promo with different mechanics (e.g. annual-only discount, no badge),
not a Founder Offer extension.

---

## 4. Levers we have without breaking the model

| Lever                            | When to use                                              |
| -------------------------------- | -------------------------------------------------------- |
| Move headline price up           | Once we hit ~50 paying shops & churn < 5%/mo             |
| Add a tier above Studio          | If we land an enterprise client with a real custom need  |
| Seasonal promo (separate code)   | Black Friday, end-of-tax-year (Mar/Apr), summer-quiet    |
| Annual-only discount             | If monthly churn exceeds 8%/mo                           |
| Tighten Starter (drop to 100 exports) | If Starter retention < 30% at month 3 (signals it's serving the wrong buyer) |
| Add a "Solo" lower tier (£9–£12) | Only after we've stopped acquiring Starter signups (i.e. we've saturated the £25 buyer) |

The thing we will _not_ do: drop headline prices. Once the £25 / £49 /
£99 ladder is set, lowering it signals failure and burns the
willingness-to-pay we've built.

---

## 5. Marketing positioning per tier

### Starter (£25)

> "For solo print operators getting started."

The buyer here is one person, often part-time, often running Printlay
between a day job and a side hustle. They want a clear price, no
gotchas, and a system they can grow into.

**Hook:** _Stop dragging artwork into Illustrator at 11pm. £25 a month
and your gang sheets program themselves._

**Friction points to address in copy:**

- "I don't have many jobs yet" → 200 exports/mo is a lot.
- "What if it's not for me?" → 14-day trial, no card.

### Pro (£49) — the default

> "For working print shops. Most popular."

This is the buyer we're optimising for. Multi-operator shops, multiple
product lines, shipping daily.

**Hook:** _The control room for your gang sheets. Unlimited exports,
50 GB of catalogue space, catalogue sharing for your team._

**Friction points:**

- "We already have a system" → Yes, but does it take you 4 minutes from
  artwork to print-ready PDF?
- "Is it secure?" → Stripe billing, GDPR-compliant storage,
  per-shop catalogues with access controls.

### Studio (£99)

> "For high-volume production with custom workflows."

Production-led teams, multi-shift, often white-labelling for clients.

**Hook:** _Print on demand at the volume you actually run. API access,
white-label PDFs, 250 GB storage, advanced layouts._

**Friction points:**

- "We need our own branding on the PDF" → White-label PDF output is in
  the box.
- "We've built our own pipeline" → API access lets you keep yours and
  use Printlay as the rendering engine.

### Enterprise

> "Custom multi-seat access for larger operations."

We don't list a price. The CTA is `mailto:hello@printlay.com`. Buyer
expects bespoke pricing and onboarding.

---

## 6. Launch funnel

### Acquisition channels (priority order)

1. **Print-industry forums** — UK & EU UV/DTF Facebook groups,
   r/screenprinting subreddit. _Authentic, founder voice; not "ads"._
2. **Direct outreach to small print shops** — find them on Etsy /
   Instagram / Google Maps, send a personal email offering Founder
   pricing. Time-bounded by the 30 July deadline.
3. **YouTube tutorials & demo clips** — record 2-minute "from upload to
   gang sheet PDF in 4 moves" videos. Embed on landing.
4. **Print-trade publications** — once we have 3+ Founder shops on
   record, pitch a "small print SaaS launches" piece.
5. **Search ads** (last) — only after #1–4 produce signal. Print is a
   small enough vertical that paid search is mostly competitor traffic.

### Email cadence (Founder period)

- **Day 0** — _Welcome / start your trial_
- **Day 3** — _What 3 customers built this week_ (social proof)
- **Day 7** — _Halfway through your trial; here's what you've done so
  far_ (usage summary; nudge to plan)
- **Day 12** — _2 days left + Founder offer reminder_
- **Day 14** — _Trial ended; lock in 50% before 30 July_

(All five emails should be drafted before launch; the 30 July deadline
gives us the urgency hook in every one.)

### Final-week push (week of 24–30 July 2026)

- Banner across the landing page: _"48 hours left. Founder Offer closes
  midnight 30 July."_
- One-day email blast to anyone who signed up but never subscribed:
  _"This is the last day to lock in 50% forever."_
- Personal LinkedIn DMs from the founder to ~30 highest-engagement
  trial users.
- Pin a tweet, pin a community post.

Expect 2–3× daily-conversion-rate compared to the steady period during
this final week. If we don't see that lift, _something is wrong with
the copy, not the offer_.

---

## 7. Technical surface area

For engineers picking up this doc:

| Concern              | Lives in                                                  |
| -------------------- | --------------------------------------------------------- |
| Headline prices      | `backend/routers/billing.py` → `_PLAN_DISPLAY`            |
| Plan entitlements    | `backend/services/entitlements.py` → `PLAN_LIMITS`        |
| Coupon allow-list    | `backend/services/stripe_billing.py` → `FOUNDER_COUPON_IDS` |
| Stripe price IDs     | Fly secrets `STRIPE_PRICE_*` (not in source)              |
| Trial defaults       | `backend/services/user_provisioning.py`                   |
| Marketing copy       | `frontend/src/pages/Pricing.tsx` + landing components     |
| Legal copy           | `frontend/src/pages/Terms.tsx` (§5 price changes, §6 Founder Offer) |

Changing the headline price of a tier:

1. Update `_PLAN_DISPLAY` in `backend/routers/billing.py` (display only).
2. Create new Stripe Price objects in the Stripe dashboard.
3. Update Fly secrets `STRIPE_PRICE_<TIER>_<CADENCE>` to the new IDs.
4. Optionally migrate existing customers via the Customer Portal flow
   already wired in `stripe_billing.py:create_subscription_update_session`.
5. Email customers 30 days ahead per Terms §5.

Changing tier _limits_ (storage, exports, etc.):

1. Update `PLAN_LIMITS` in `backend/services/entitlements.py`.
2. Update `_PLAN_DISPLAY` features list in `backend/routers/billing.py`.
3. Update `PLAN_BLURBS` in `frontend/src/pages/Settings.tsx`.
4. Smoke-test the upload routes that enforce the caps:
   `routers/catalogue.py`, `routers/jobs.py`, `routers/color_profiles.py`.

---

## 8. Open questions / things to revisit

- **Founder badge meaning post-30 July** — should it grant any small
  perk (priority support, beta access)? Currently it's purely cosmetic.
  Decide before the badge becomes folklore.
- **Annual cadence default** — we ship with monthly selected on
  `/pricing` because it converts better. Revisit after 50 paying shops:
  if monthly churn is high we may swap the default to annual.
- **Storage overages** — today we hard-block uploads at the cap. A
  future, gentler model is "soft-cap with paid overage" (e.g. £1/GB-mo
  over the cap). Don't ship until we have a customer asking for it.
- **Multi-seat / team pricing** — Pro currently maps to one user. We
  haven't priced for shops with 3–5 designers. A "Pro Team" addon at
  +£15/seat is the obvious next move.
- **Refund policy for trial-to-paid mistakes** — informal today (we'll
  refund if a shop emails us within 7 days of a renewal). Codify
  publicly once we hit ~50 shops.

---

## 9. Decision log

| Date          | Decision                                      | Why                                                      |
| ------------- | --------------------------------------------- | -------------------------------------------------------- |
| 26 Apr 2026   | Founder Offer extended 30 Jun → 30 Jul 2026   | More runway for content cycle + final-week push          |
| 26 Apr 2026   | Founder Offer codified as % discount in Terms | Keeps headline-pricing flexibility for future            |
| 26 Apr 2026   | Starter raised £19 → £25                      | Headroom for 50% promo + brand positioning vs hobby SaaS |
| 26 Apr 2026   | Starter exports 50 → 200                      | 50 was too tight; sent the wrong "this is restricted" signal |
| 26 Apr 2026   | Storage caps added per tier (5/50/250 GB)     | Real server cost; previously unbounded                   |
| 26 Apr 2026   | Trial storage capped at 1 GB                  | Stops trial accounts dumping a permanent library         |
