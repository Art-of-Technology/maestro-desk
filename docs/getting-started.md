# Getting started with Respovia

A practical guide to using Respovia — the AI-native, multi-brand helpdesk for iGaming
brands. This is a **user & administrator** guide (how to work in the product). For local
development and deployment, see [`README.md`](../README.md), [`setup.md`](../setup.md),
and [`PROD_SETUP.md`](../PROD_SETUP.md).

## Who does what

Respovia has three roles:

| Role | Who | What they do |
|---|---|---|
| **Agent** | Support staff | Work the ticket queue for the brand(s) they belong to — reply, triage, resolve. |
| **Brand Owner** (Admin) | The person running a brand's support | Everything an agent does, plus invite/remove agents and configure the workspace (categories, canned responses, retention, integrations, AI settings). |
| **Platform operator** (God) | The team running the platform itself | Creates brands, invites Brand Owners, and manages platform-wide settings. Reached from the **Platform · Brands** panel (visible only to platform operators). |

A **brand** is a workspace. One Brand Owner can own several brands; one agent can belong
to several. Everything a player sees is scoped to a brand.

## First sign-in

Respovia is **invite-only** — you can't self-register.

1. You receive an invitation email. Open it and follow the link to set your password.
2. Sign in at your Desk URL with your email and password.
3. If you belong to more than one brand, you'll be asked to pick one; you can switch
   brands later from the sidebar without signing out.

**Signing in with Maestro:** if your organisation uses Maestro Connect, use **Sign in with
Maestro** instead of a password — you'll be sent to Maestro to authorise, then returned to
your Desk workspace.

**Forgot your password?** Use the "Forgot password" link on the sign-in page. A Brand
Owner can also trigger a reset for anyone on their team.

> **"Failed to fetch" on the sign-in page** almost always means the app can't reach the
> API — not a wrong password. If you're running locally, start the API first (see the
> README).

## Finding your way around

The left sidebar is grouped into three sections:

**Work**
- **Dashboard** — your at-a-glance view: open tickets, what's awaiting your reply, activity.
- **Conversations** — the ticket queue. This is where you spend most of your day.
- **Customers** — the players who've contacted you: their profile, history, and (where
  connected) live Maestro account context.

**Insight**
- **Insights** — reports on volume, response times, CSAT, and team performance.
- **AI Intelligence** — AI activity and cost: what the AI has triaged/drafted and how much
  it's spending against the budget.

**Library**
- **Knowledge** — your knowledge base: articles for agents and, where enabled, players.
- **Agents** — (Brand Owners) manage the people on your team.

The **settings cog** in the top bar opens the **Configuration hub** — one page with every
workspace setting grouped into cards (see *Administering a brand* below).

## Working a ticket (agents)

1. Open **Conversations** and pick a ticket. Tickets arrive from your web portal,
   inbound email, and Slack, and each carries a stable per-brand ID.
2. Read the thread. The AI may have already **triaged** it (category, priority, sentiment)
   and **drafted a suggested reply** — review it, don't send blind.
3. Use the AI helpers as needed: **summarise** a long thread, **translate** a message, or
   **draft** a reply you then edit.
4. Reply from the ticket. Public replies are emailed to the player and thread back into the
   same conversation when they respond.
5. Set the status (e.g. resolved) and, if used, leave an internal note or @mention a
   teammate. Assignment rules may route new tickets to you automatically.

A few things that help at volume:
- **Sentiment** is scored automatically so you can spot unhappy players.
- **Responsible-gambling safety**: the AI will not auto-reply to a player who shows
  self-exclusion or harm signals — those are held for a human.
- **CSAT**: resolved tickets can trigger a satisfaction survey (consent-respecting, with an
  unsubscribe link).

## Administering a brand (Brand Owners)

From the **Configuration hub** (top-bar cog) you can:

- **Invite and manage agents** (also under **Agents** in the sidebar). Deactivate an agent
  to revoke access; it sticks even if they sign in again via Maestro.
- **Categories, canned responses, and ticket templates** for your queue.
- **Branding** — your logo and colours; the player-facing portal and emails use them.
- **Integrations** — email (Postmark), Slack, and outbound webhooks.
- **AI settings** — enable/limit AI features and set the spend budget. Sharing player
  details with the AI is **off by default**; turn it on per brand only if your data
  agreement allows it.
- **Data & compliance** — set the **retention window** (how long resolved tickets are kept
  before automatic purge), export a player's data (DSAR), or erase a player on request.

## Administering the platform (Platform operators)

The **Platform · Brands** panel is where you create brands, invite their Brand Owners, and
manage platform-wide concerns. Destructive actions (e.g. suspending a brand) require
type-to-confirm. Day-to-day brand administration belongs to each Brand Owner.

## Getting help

- Product architecture and contributor docs: [`CLAUDE.md`](../CLAUDE.md).
- Running it yourself: [`README.md`](../README.md) and [`setup.md`](../setup.md).
- Production operations and recovery: [`docs/backup-recovery.md`](./backup-recovery.md).
