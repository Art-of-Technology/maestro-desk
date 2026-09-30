export const GUIDE_STEPS = [
  {
    id: 'dashboard',
    page: 'dashboard',
    title: 'See what needs attention',
    body: 'Use the dashboard for today’s workload, replies, and team activity.',
    source: 'web/js/dashboard/index.js',
    highlights: ["Check your workspace and ask your lead which queue to use.","Use the sidebar to open Tickets, Customers or Knowledge Base.","This tour changes nothing. Exit whenever you are ready to try it."],
    instructions: [
      'Sign in with the account your team provided and check that you are in the right workspace. Ask your lead for access if you cannot see the tickets you need.',
      'Your session ends eight hours after login. A warning appears 30 minutes before expiry while you are active in the app. Finish your current work, then sign in again when prompted; staying active does not extend the session.',
      'Use the sidebar to move between Tickets, Customers and Knowledge Base. The dashboard gives you an overview of workload and team activity.',
      'This tour explains the controls without sending replies or changing tickets. Choose Exit to practise, then select Guides in the top bar and choose a topic. You can also open Guided tours from Help & Support.',
      'Ask your lead which queue you own, how to verify a customer, and who handles payment, privacy and safer-gambling escalations. Follow your team’s procedures for those decisions.',
    ],
  },
  {
    id: 'tickets',
    page: 'tickets',
    title: 'Work through player requests',
    body: 'Open a ticket to reply, add a note, assign it, or change its status.',
    source: 'web/js/tickets/list.js',
    highlights: ["Choose a ticket from your queue and check its priority and SLA.","Read the conversation, email dates, receiving inbox and internal notes.","Check ownership so two agents do not reply at once."],
    instructions: [
      'Open Tickets. Check Outstanding for work still needing attention, or Unassigned when your team asks you to pick up new work. The Inbox column shows where each ticket sits; select its heading to sort by inbox name.',
      'Use search and filters to narrow the list by agent, priority or category. Under More filters, use Inbox to choose a mailbox or find tickets with no inbox assigned. Remove the Inbox chip to show all inboxes again. Saved searches remember the inbox selection. Clear filters if a ticket seems to be missing; check Snoozed and the resolved or closed status views too.',
      'Check priority and SLA indicators before choosing a ticket. SLA shows response or resolution timing; follow your team’s order of work when something is overdue.',
      'Select a ticket to open its conversation. Check the assigned agent and any indicators that someone else is composing before starting a second reply.',
      'Inbox below the subject shows where the ticket sits. Open the Inbox dropdown to see its email address or choose Move to inbox. Choose the appropriate inbox and select Move; the confirmation offers Undo. Future replies default to the new inbox when its sender is verified. Received via on earlier messages keeps the original receiving address.',
    ],
  },
  {
    id: 'review', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Review before replying',
    body: 'Read the customer’s request and the work already done.',
    highlights: ["Check the customer, brand and previous conversation.","Use current guidance to verify facts and promises.","Treat AI summaries as a starting point; check them against the ticket."],
    instructions: [
      'Read the latest customer message, then earlier replies and internal notes. Identify the question, any promises already made, and what is still unanswered.',
      'Open Details if the ticket sidebar is hidden. Check the customer, email, brand, jurisdiction, category and assigned agent. Use the copy button beside the email address to copy it. Other tickets shows ticket IDs and creation dates; times use your local timezone when available. Use Copy link beside the current ticket ID in the header to share it. Under Other tickets, copy an ID with its copy button, use Copy link to share a direct link, or select the subject to open the ticket. If copying a link fails, right-click Copy link and copy the link address. Review relevant attachments and linked tickets.',
      'Use More → Summarize for an AI summary, then verify it against the conversation. Refresh a summary marked stale before relying on it for a handover.',
      'Change status and priority using the compact controls below the subject. Tags sit beside them. To change the category, open Details and use Category under Properties. Category is separate from tags.',
      'In Details, use Generate tags under AI Tag Suggestions, then accept the relevant tags. This uses workspace AI credit without sending a reply or changing your draft. If it fails, follow the error message and use Retry. Accepted tags are kept.',
      'Check account facts and current guidance before promising a payment, refund, bonus or deadline. If evidence is missing, ask for it or escalate through your team’s process.',
    ],
  },
  {
    id: 'customers',
    page: 'customers',
    title: 'Understand the player',
    body: 'Find player details, previous tickets, and account context here.',
    source: 'web/js/customers/index.js',
    highlights: ["Open the customer from the ticket’s Details panel.","Check previous tickets for related issues.","Follow your team’s identity checks before sharing account information."],
    instructions: [
      'Open Customers and select the customer, or select the Customer section in a ticket’s Details sidebar.',
      'Check that the record belongs to the person and brand you are supporting. Review previous tickets for related problems and commitments.',
      'Follow your team’s identity checks before disclosing account information or acting on a request. Include only the customer information needed in replies and notes.',
    ],
  },
  {
    id: 'knowledge',
    page: 'kb',
    title: 'Find trusted answers',
    body: 'Search approved articles before replying to a player.',
    source: 'web/js/kb/index.js',
    highlights: ["Search Knowledge Base for the issue.","Check the article’s review status, brand and market.","Ask your lead if guidance is missing or conflicting."],
    instructions: [
      'Open Knowledge Base and search for the issue. Read the relevant article rather than relying only on its title or search preview.',
      'Check the article’s review status, scope and currency. Confirm that its brand or market matches the customer before applying the advice.',
      'Previous replies can help with wording, but do not prove that a policy or account outcome applies to this customer. Ask your lead when sources conflict or no approved answer exists.',
    ],
  },
  {
    id: 'reply', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Write a customer reply',
    body: 'Choose Reply, answer the question and check what the customer will receive.',
    highlights: ["Choose Reply for the customer, or Internal note for colleagues.","Answer the question and explain the next action.","Check To, CC, language, facts and attachments before sending."],
    instructions: [
      'Open the ticket and choose Reply. Expand gives you more writing space and temporarily hides ticket details; Restore returns to the previous layout. Use Internal note only for information intended for colleagues; check the selected tab before writing.',
      'Acknowledge the issue, answer each question and explain the next action. Use the editor for formatting and Attach for relevant files. Check the attachments belong to this customer.',
      'Automatic customer language detection uses the subject and latest customer message. Substantive body text takes precedence if they differ; you can choose a language manually.',
      'In the email composer, choose Reply for the sender or Reply all to include the other recipients. Choose From to send through a verified inbox, then check To and edit CC before sending. Your own inboxes and duplicate addresses are excluded.',
      'Open Change beside the reply language to check the customer language and the “Send replies in customer language” setting. If translation is enabled, the outgoing reply may differ from the wording in your editor.',
      'Drafts are saved in this browser separately for Reply and Internal note. A restored draft has not been sent. Do not assume an ordinary draft is available on another device.',
    ],
  },
  {
    id: 'templates', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Use templates and placeholders',
    body: 'Personalise a saved response and fill missing details before inserting it.',
    highlights: ["Choose Tools → Macros and preview a saved response.","Fill every placeholder with verified customer details.","Insert, personalise and reread. Inserting does not send the reply."],
    instructions: [
      'In the Reply composer, choose Tools → Macros to open “Insert canned response”, then select a response. Read the “Preview response” window before choosing Insert response.',
      'Templates fill {name} with the customer’s first name, {ticket} with the ticket ID, and {brand} with the customer’s brand when available. {agent} uses the assigned agent, falling back to your session name when no agent is assigned. Check the signature.',
      'Fill each missing field with verified details. For example, replace {transaction_reference} with this customer’s actual reference. If you do not know a value, cancel and investigate or choose a different response.',
      'Insert response adds the template to your existing draft. Remove duplicate greetings or outdated text, then reread the whole reply. Inserting a response does not send it.',
      'Tools ▾ in the composer offers Customer name, Ticket ID, Brand and Agent name at the cursor. These insert available values directly; typing a token yourself does not automatically fill it. Replies containing unfilled placeholders are blocked.',
      'If a preview reports an unfilled field in formatting or links, ask a template editor to fix it. Admins can use Save as template; remove personal details and one-off promises before saving reusable wording.',
    ],
  },
  {
    id: 'ai-review', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Review an AI suggestion',
    body: 'Check sources and edit the draft before sending it.',
    highlights: ["Use AI → Draft reply to prepare a suggestion.","Check its references and verify every claim.","Edit the draft before sending; AI suggestions can be wrong."],
    instructions: [
      'Use AI ▾ → Draft reply, or Tools → Similar replies when available. AI ▾ also offers writing changes such as Shorten and Improve writing. These prepare text for you to review.',
      'Read the entire suggestion. Verify the name, brand, language, amounts, eligibility, deadlines and next steps against this ticket and current guidance.',
      'Expand the AI suggestion summary, then choose References to inspect supporting articles or previous replies, including dates, markets and warnings. No references means you must verify claims yourself. References and internal review notes are not sent to the customer.',
      'Edit incorrect or irrelevant wording. If the suggestion is unsuitable, Discard clears it from the composer. Give feedback lets you choose Helpful or Not helpful and a reason; feedback alone does not change the draft.',
      'If a shared draft is available, review your current text before choosing Load shared draft because it replaces the local reply. Recheck a suggestion marked Needs review against the latest conversation.',
    ],
  },
  {
    id: 'send', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Check and send',
    body: 'Make the final check, send once and confirm the result.',
    highlights: ["Check the customer, language, attachments and any remaining placeholders.","Read any warnings, then send once.","Check the saved message and delivery notice before retrying."],
    instructions: [
      'Before sending, confirm the correct ticket and Reply tab, customer name, language, facts, links and attachments. Remove placeholders and internal-only information.',
      'Choose Send to submit the reply. The arrow beside it offers Send and resolve, Send and set pending, or Send and escalate when you also want to change the status.',
      'If “Check before sending” appears, read each warning. Cancel to fix or verify the draft. Confirm only after checking; the warning cannot verify policy or payment claims for you.',
      'Wait for the result and check the conversation and any delivery notice. If sending fails, read the error and check whether the message was saved before retrying. After a combined send-and-status action, also check the displayed status.',
    ],
  },
  {
    id: 'statuses', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Choose the right status',
    body: 'Record whether work is active, waiting, escalated or finished.',
    highlights: ["Use Open for work in progress, or Pending when waiting.","Escalate with a handover note when you need help.","Resolve completed work. Follow your team’s process for privacy requests."],
    instructions: [
      'Open Details → Properties → Ticket status to change status without composing a reply. Changing the status is separate from explaining the outcome to the customer.',
      'Open: work still needs attention. Pending: waiting for information or another action; leave a note stating what you are waiting for and who will follow up.',
      'Escalated: the issue needs further help. Use More → Escalate or the status selector, assign the appropriate agent and leave a handover note. A status change alone does not explain the issue to the next person.',
      'GDPR: use for privacy requests under your team’s process. Ask the responsible colleague how to proceed before using data export, redaction or erasure controls.',
      'Resolved: the issue has been answered or completed. Choose Resolve, or Send and resolve when sending the final reply. Choose Reopen if more work is needed.',
      'Closed: use More → Close without resolution for spam, abuse, a duplicate or another reason that is not a successful resolution. Select the required reason and add context if needed. This action sends no customer email or satisfaction survey.',
      'Spam: use More → Mark as spam, or select tickets and choose Mark as spam. This closes the tickets and filters future emails from their contacts in this workspace. Use Unmark contact as spam on the ticket or contact to stop filtering; old spam tickets stay closed.',
    ],
  },
  {
    id: 'handover', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Leave notes and hand over',
    body: 'Give the next agent enough context to continue without repeating work.',
    highlights: ["Add an Internal note with the checks done and next action.","Name the next owner and assign the ticket.","Use Snooze for a timed follow-up; leave a note explaining why."],
    instructions: [
      'Choose Internal note. State the issue, checks completed, outcome, outstanding action and next owner. Type @ and choose a colleague to mention them, then choose Add note.',
      'Internal notes are for your team and are not customer replies. Send a separate Reply if the customer needs an update.',
      'In Details → Properties, change Assigned agent and Ticket priority as needed. Check availability and agree ownership using your team’s process.',
      'For a timed follow-up, use More → Snooze and choose a return time. Find deferred tickets in the Snoozed view; use More → Wake up to bring one back early. Leave a note explaining what to check when it returns.',
      'Before applying a workflow macro or bulk action, check its actions and the selected tickets. These can change status, assignment or other properties across multiple requests.',
    ],
  },
  {
    id: 'agents',
    page: 'agents',
    title: 'See who is available',
    body: 'Review teammates, roles, workload, and availability.',
    source: 'web/js/agents/index.js',
    highlights: ["Check teammates’ roles and workload before handing over.","Choose a performance period; current workload stays separate.","Return to Guides whenever you need a reminder."],
    instructions: [
      'Open Agents to review teammates, roles, workload and availability. Use your team’s escalation process to find the right owner for a specialist issue.',
      'Choose Last 7 days, Last 30 days, Last 90 days or All time to compare performance. The dates appear beside the filter. Current workload always shows tickets needing attention now.',
      'Send and resolve credits the agent who resolves the ticket, regardless of its assignee. Each ticket counts once per agent in the selected period. Open an agent for saved replies, tickets handled and the counting explanation.',
      'If a control is missing, ask your lead whether your role or workspace has access. Some AI, template and administration controls depend on configuration or permissions.',
      'Use / to focus global search when you are not typing in a field. Use the arrow keys to select a result, Enter to open it and Escape to dismiss search.',
      'You can revisit any topic through Help & Support → Guided tours. Ask your lead when the app’s options do not tell you which business decision to make.',
    ],
  },
  {
    id: 'checklist', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Handle your first ticket',
    body: 'Use this checklist on a ticket your team has approved for you to handle.',
    highlights: ["Read the ticket, confirm the customer and check current guidance.","Write and verify the reply, then send and check the result.","Set the status and record the next action and owner."],
    instructions: [
      'Choose a ticket in your queue. Confirm ownership, urgency and the correct customer.',
      'Read the conversation and notes, check customer context, and find the current guidance.',
      'Write a Reply or personalise a template. Verify AI suggestions, fill placeholders, and check language and attachments.',
      'Reread the final reply, send it, and check the saved message and delivery notice.',
      'Set the appropriate status. Record the next action, owner and follow-up in an internal note when work remains.',
      'Choose Finish to close the tour, then open your ticket. Return to Guided tours whenever you need a reminder.',
    ],
  },
];

export const QUICK_START_IDS = ['dashboard', 'tickets', 'reply', 'send', 'handover'];

// Changing any guide step automatically gives it a new completion version.
export const GUIDE_VERSION = JSON.stringify(GUIDE_STEPS);

export function validateGuideConfig(steps = GUIDE_STEPS) {
  const ids = new Set();
  for (const step of steps) {
    if (!step.id || !step.page || !step.title || !step.body || !step.source) throw new Error('Every guide step needs an id, page, title, body, and source.');
    if (ids.has(step.id)) throw new Error(`Duplicate guide step: ${step.id}`);
    if (step.title.length > 40 || step.body.length > 100) throw new Error(`Guide copy is too long: ${step.id}`);
    if (!Array.isArray(step.instructions) || !step.instructions.length || step.instructions.some(text => typeof text !== 'string' || !text.trim())) throw new Error(`Guide instructions are missing: ${step.id}`);
    if (!Array.isArray(step.highlights) || !step.highlights.length || step.highlights.length > 3 || step.highlights.some(text => typeof text !== 'string' || !text.trim() || text.length > 120)) throw new Error(`Guide highlights must contain 1–3 short instructions: ${step.id}`);
    ids.add(step.id);
  }
  return true;
}
