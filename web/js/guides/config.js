export const GUIDE_STEPS = [
  {
    id: 'dashboard',
    page: 'dashboard',
    title: 'See what needs attention',
    body: 'Use the dashboard for today’s workload, replies, and team activity.',
    source: 'web/js/dashboard/index.js',
    highlights: ["Check your workspace and ask your lead which queue to use.","Use the navigation menu to open Tickets, Customers or Knowledge Base.","This tour changes nothing. Exit whenever you are ready to try it."],
    instructions: [
      'Sign in with the account your team provided and check that you are in the right workspace. Ask your lead for access if you cannot see the tickets you need.',
      'Maestro sign-in uses brands you can access in Maestro Connect. If a brand needs a new Respovia workspace, choose Request a Respovia workspace. After a platform administrator approves it, choose Refresh brands or sign in again.',
      'Your session ends eight hours after login. A warning appears 30 minutes before expiry while you are active in the app. Wait for drafts to show Synced before expiry. When the session ends, browser draft copies are cleared, including unsynced edits. Sign in again to restore server-saved drafts; staying active does not extend the session.',
      'Use the navigation menu to move between Tickets, Customers and Knowledge Base. It appears on the left or at the top, depending on your Appearance settings. The dashboard gives you an overview of workload and team activity.',
      'On Dashboard and Insights, use View as on a statistic to choose a table, chart or graph where available. Each choice syncs privately for your account and workspace. Wait for Synced before continuing on another device, then refresh or sign in there to load it. Saved in this browser means the choice has not synced yet; it retries when you reconnect or return to that statistic. Existing browser choices are imported only where no synced choice exists. If devices change the same statistic, the last successful save wins. Demo choices stay in this browser.',
      'Manage widgets controls which cards appear on Dashboard and Insights. Drag card headers to change their order. Order and visibility sync separately for each page, account and workspace. Wait for Layout synced, then refresh or sign in on another device. Retry saves a change that could not sync; pending changes also retry after reconnecting or refreshing. Reset layout restores that page’s default order and shows all widgets. Import browser layout replaces the current page’s layout with an old browser-only layout; import it only if it is yours. If devices edit the same page, the last successful save wins. New widgets appear at the end.',
      'Guides explain controls without sending replies or changing records. Exit to practise on work approved by your team. Reopen Guides to resume and confirm your practice checklist. Viewed and practice confirmed are recorded separately in this browser.',
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
    ],
  },
  {
    id: 'review', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Review before replying',
    body: 'Read the customer’s request and the work already done.',
    highlights: ["Check the customer, brand and previous conversation.","Use current guidance to verify facts and promises.","Treat AI summaries as a starting point; check them against the ticket."],
    instructions: [
      'Read the latest customer message, then earlier replies and internal notes. Use Jump to latest above the conversation to return to the beginning of the newest email or note. Identify the question, any promises already made, and what is still unanswered.',
      'Private file links expire after five minutes. If a link expires, refresh the ticket and open the file again. Files are unavailable while the brand is suspended.',
      'Open Details if the ticket sidebar is hidden. Check the customer, email, brand, jurisdiction, category and assigned agent. Use the copy button beside the email address to copy it. Other tickets shows ticket IDs and creation dates; times use your local timezone when available. Use Copy link beside the current ticket ID in the header to share it. Under Other tickets, copy an ID with its copy button, use Copy link to share a direct link, or select the subject to open the ticket. If copying a link fails, right-click Copy link and copy the link address. Review relevant attachments and linked tickets.',
      'Use More → Summarize for an AI summary, then verify it against the conversation. Refresh a summary marked stale before relying on it for a handover.',
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
      'Open Customers and select the customer, or choose a customer result in the search bar. From a ticket’s Details sidebar, select the Customer section, then View full profile.',
      'Check that the record belongs to the person and brand you are supporting. Review the Tickets section for related problems and commitments. Use Load more to see older tickets. If history could not be loaded, select Try again.',
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
    highlights: ['Choose Reply and check who will receive your message.', 'Answer the question and explain the next action.', 'Check To, CC, language, facts and attachments before sending.'],
    instructions: [
      'Open the ticket and choose Reply. On phones, the composer fills the screen below the ticket breadcrumb; Minimise returns to the conversation and keeps your draft. Swipe the bottom icon row to reach more tools. On larger screens, Expand gives you more writing space and temporarily hides ticket details; Restore returns to the previous layout. Use Internal note only for information intended for colleagues; check the selected tab before writing.',
      'Acknowledge the issue, answer each question and explain the next action. Use the editor for formatting and Attach for relevant files. Check the attachments belong to this customer.',
      'Automatic customer language detection uses the subject and latest customer message. Substantive body text takes precedence if they differ; you can choose a language manually.',
      'Above the email editor, choose From and Reply or Reply all in the first row, then check To below. Choose Cc to add email addresses; existing Cc recipients stay visible. Your own inboxes and duplicate addresses are excluded.',
      'Open Change beside the reply language to check the customer language and the “Send replies in customer language” setting. Selecting a language closes the options. If translation is enabled, the outgoing reply may differ from the wording in your editor. Email headers, footers and signatures use the reply language; logos stay unchanged.',
      'For a new outbound ticket, confirm the conversation language before writing the first message. Respovia uses the customer’s saved preferred language first, then suggests a language from their jurisdiction when possible. Your confirmed choice is saved on the customer profile for future conversations. Change or clear Preferred language under Edit details on the profile. You can change Reply language beneath the message for this conversation only. As written uses the language of your message. The subject is translated when the first message is sent. If translation fails, your draft is kept.',
      'In the first-message step, choose files under Attachments. You can remove files before continuing. Files upload only when you choose Send or Save as draft; saving keeps them private with your unsent message. Use up to 20 files, at most 10 MB each; sending allows 7 MB total. If uploading fails after the ticket is created, retry in the same form. Successful uploads are kept and no message is sent until every selected file is ready. Cancel opens the existing draft; files that have not uploaded must be selected again.',
      'If AI is unavailable, choose Send without AI in the Send menu, or below the message on a new ticket. Confirm that the customer can understand the message, subject and saved header, signature and footer. None will be translated for that send. This does not change your language preference.',
      'Choose Save draft and exit below the editor to sync your draft and return to Tickets without sending. Reply and Internal note drafts are private to your account and workspace. Wait for Synced before continuing on another device. Saved locally means the draft is only in this browser until sync succeeds. Signing out saves pending drafts first, then clears your browser copies across tabs and workspaces. If saving fails or other unsaved copies remain, you can stay signed in or explicitly discard them. If two devices have different edits, choose Review draft copies before continuing. Uploaded files sync with your reply draft. Wait for uploads and draft sync to finish before leaving. Image attachments show thumbnails; PDFs and other files show a type badge. Select an attachment to preview images and PDFs here; other file types can be downloaded.',
    ],
    permissions: ['tickets.reply'],
  },
  {
    id: 'templates', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Use templates and placeholders',
    body: 'Personalise a saved response and fill missing details before inserting it.',
    highlights: ["Search saved responses by name, category or reply text, then preview a match.","Fill every placeholder with verified customer details.","Insert, personalise and reread. Inserting does not send the reply."],
    instructions: [
      'In the Reply composer, choose the Insert template icon below your reply, or press Ctrl/Cmd+Shift+Space while typing, to open “Response templates”. Search by name, category or reply text and use Category to narrow the results. Use the arrow keys to choose and Enter to preview, or click a response. Escape closes the picker.',
      'Read the “Preview response” window before choosing Insert response. The full Response Templates library also has search and category filters; choose Uncategorised to find responses without a category.',
      'Choose Pin beside a response in the picker or full library to save it as a personal favourite for this workspace. Favourites appear first in the picker and above the Reply composer. Select a favourite to open its preview. Choose Unpin to remove it. Wait for Saving… to finish; if saving fails, try again. Saved favourites follow your account across devices when you reopen the picker or ticket.',
      'When starting a new conversation, use Search templates and Template category in both the details and first-message steps. Search matches the template name, subject, category and message. Filtering does not apply a template or change the ticket category. A selected starter stays under Current selection if it falls outside the filters. Choosing a template in the first-message step appends it to your draft.',
      'Templates fill {name} with the customer’s first name, {ticket} with the ticket ID, and {brand} with the customer’s brand when available. {agent} uses the assigned agent, falling back to your session name when no agent is assigned. Check the signature.',
      'Fill each missing field with verified details. For example, replace {transaction_reference} with this customer’s actual reference. If you do not know a value, cancel and investigate or choose a different response.',
      'Insert response adds the template to your existing draft. Remove duplicate greetings or outdated text, then reread the whole reply. Inserting a response does not send it.',
      'The person, number sign, building and headset icons below the editor insert Customer name, Ticket ID, Brand and Agent name at the cursor. Hover over a button to see its label. These insert available values directly; typing a token yourself does not automatically fill it. Replies containing unfilled placeholders are blocked.',
      'If a preview reports an unfilled field in formatting or links, ask a template editor to fix it.',
    ],
    permissions: ['tickets.reply'],
  },
  {
    id: 'ai-review', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Review an AI suggestion',
    body: 'Check sources and edit the draft before sending it.',
    highlights: ["Use AI → Draft reply to prepare a suggestion.","Check its references and verify every claim.","Edit the draft before sending; AI suggestions can be wrong."],
    instructions: [
      'Use AI ▾ → Draft reply, or the Similar replies icon below the editor when available. AI ▾ also offers writing changes such as Shorten and Improve writing. These prepare text for you to review.',
      'If AI cannot generate a reply, read the guidance beside the editor. Your existing draft is kept. For insufficient credit, ask a platform administrator to add credit, then choose Draft reply again; a failed language check will retry.',
      'Read the entire suggestion. Verify the name, brand, language, amounts, eligibility, deadlines and next steps against this ticket and current guidance.',
      'Expand the AI suggestion summary, then choose References to inspect supporting articles or previous replies, including dates, markets and warnings. No references means you must verify claims yourself. References and internal review notes are not sent to the customer.',
      'Edit incorrect or irrelevant wording. If the suggestion is unsuitable, Discard clears it from the composer. Give feedback lets you choose Helpful or Not helpful and a reason; feedback alone does not change the draft.',
      'If a shared draft is available, review your current text before choosing Load shared draft because it replaces the local reply. Recheck a suggestion marked Needs review against the latest conversation.',
    ],
    permissions: ['tickets.reply', 'tools.ai'],
  },
  {
    id: 'send', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Check and send',
    body: 'Make the final check, send once and confirm the result.',
    highlights: ["Check the customer, language, attachments and any remaining placeholders.","Read any warnings, then send once.","Check the saved message and delivery notice before retrying."],
    instructions: [
      'Before sending, confirm the correct ticket and Reply tab, customer name, language, facts, links and attachments. Remove placeholders and internal-only information.',
      'If closing is not confirmed after sending, a reminder stays above the conversation. Open or refresh the ticket on another device using the same agent account and workspace to see it there. Retry close only checks the current status and opens the close dialog without sending another email. Choose a reason if required. Dismiss reminder removes the notice across devices without changing the ticket status. If sync fails, the change stays in this browser and retries when you reconnect or reopen the ticket. An older offline change cannot replace a newer saved version.',
      'If “Check before sending” appears, read each warning. Cancel to fix or verify the draft. Confirm only after checking; the warning cannot verify policy or payment claims for you.',
      'Wait for the result and check the conversation and delivery notice. Sent means the email provider accepted the send. Partially delivered means some recipients are confirmed; Delivered means every recipient\'s mail server accepted the email. Check Delivery confirmed in the email details for each recipient and time. This does not confirm that someone read the email or that it reached their inbox. Use Retry sending on a failed reply to resend the saved email and attachments without adding another message. Respovia blocks retries when delivery is unconfirmed to avoid sending the email twice. After a combined send-and-status action, also check the displayed status.',
    ],
    permissions: ['tickets.reply'],
  },
  {
    id: 'statuses', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Choose the right status',
    body: 'Record whether work is active, waiting, escalated or finished.',
    highlights: ["Use Open for work in progress, or Pending when waiting.","Escalate with a handover note when you need help.","Resolve completed work. Follow your team’s process for privacy requests."],
    instructions: [
      'Use the same send actions on a new ticket or a reply: Send keeps a new ticket open and preserves the current status of an existing ticket; Send & resolve marks it resolved and follows the brand’s survey rules; Send & close marks it closed without a survey; Send & pending or Send & escalate keeps it outstanding in that status without a survey. Status changes require confirmed email sending and any required reason. If a status update fails after sending, retry the status update only; do not send the message again. Existing custom statuses are also available when your role permits them.',
      'Use Ticket status below the subject to change status without composing a reply. Changing the status is separate from explaining the outcome to the customer.',
      'Custom choices appear in ticket status, bulk actions, macros and the send menu. Use the status filter beside the queue tabs to find a specific choice. Reports and SLAs use its workflow category. Survey policy is saved when the choice is selected, so later settings edits affect future selections. A no-survey selection also blocks manual survey sending; it cannot recall a survey already sent.',
      'Open: work still needs attention. Pending: waiting for information or another action; leave a note stating what you are waiting for and who will follow up.',
      'Escalated: the issue needs further help. Use More → Escalate or the status selector, assign the appropriate agent and leave a handover note. A status change alone does not explain the issue to the next person.',
      'GDPR: use for privacy requests under your team’s process. Ask the responsible colleague how to proceed before using data export, redaction or erasure controls.',
      'Resolved: the issue has been answered or completed. Choose Resolve, or Send & resolve when sending the final reply. Choose Reopen if more work is needed.',
      'Closed: use More → Close without resolution for spam, abuse, a duplicate or another reason that is not a successful resolution. Select the required reason and add context if needed. This action sends no customer email or satisfaction survey.',
      'Spam: use More → Mark as spam, or select tickets and choose Mark as spam. This closes the tickets and filters future emails from their contacts in this workspace. Use Unmark contact as spam on the ticket or contact to stop filtering; old spam tickets stay closed.',
    ],
    permissions: ['tickets.edit', 'tickets.close'],
  },
  {
    id: 'handover', page: 'tickets', target: 'tickets', source: 'web/js/tickets/list.js',
    title: 'Leave notes and hand over',
    body: 'Give the next agent enough context to continue without repeating work.',
    highlights: ['Use your team’s handover process to agree the next owner.', 'Record what happened and what still needs attention.', 'Check that the next colleague can continue without repeating work.'],
    instructions: [
      'Choose Internal note. State the issue, checks completed, outcome, outstanding action and next owner. Type @ and choose a colleague to mention them, then choose Add note.',
      'Internal notes are for your team and are not customer replies. Send a separate Reply if the customer needs an update.',
    ],
    permissions: ['tickets.note'],
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
      'When a teammate or an assignment rule assigns a ticket to you, Respovia emails you a link to the ticket. Assigning a ticket to yourself or saving the same assignee again sends no email. To turn these emails off, open Settings → Notifications and switch off Assignment emails. This preference applies across devices.',
      'Choose Last 7 days, Last 30 days, Last 90 days or All time to compare performance. The dates appear beside the filter. Current workload always shows tickets needing attention now.',
      'Send & resolve credits the agent who resolves the ticket, regardless of its assignee. Each ticket counts once per agent in the selected period. Open an agent for saved replies, tickets handled and the counting explanation.',
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
      'Choose Next to record that you viewed this step. Exit to work on your approved ticket, then reopen Guides to confirm your practice.',
    ],
    permissions: ['tickets.reply', 'tickets.edit', 'tickets.close', 'tickets.note'],
  },
  {
    id: 'create',
    page: 'tickets',
    target: 'tickets',
    source: 'web/js/tickets/list.js',
    title: 'Create a ticket and save a draft',
    body: 'Check the customer and inbox, prepare a message, then save before sending.',
    highlights: [
      'Choose New ticket and check the customer, inbox and subject.',
      'Confirm the conversation language and prepare the first message.',
      'Save as draft keeps the message unsent; wait for the save result.',
    ],
    instructions: [
      'Choose New ticket. Select the correct customer, receiving inbox and subject. Check the customer email before continuing to the first message.',
      'Confirm the conversation language. Write the first message, or choose a starter template and check every detail.',
      'Save as draft creates an unsent ticket. Check that it appears in Tickets and reopen it before continuing. The walkthrough never creates or sends a ticket for you.',
    ],
    permissions: [
      'tickets.create',
    ],
  },
  {
    id: 'attachments',
    page: 'tickets',
    target: 'tickets',
    source: 'web/js/tickets/list.js',
    title: 'Add and check attachments',
    body: 'Attach only the files needed for this customer and check the upload result.',
    highlights: [
      'Choose Attachments in the first-message form or reply composer.',
      'Check every file and remove anything unintended.',
      'Wait for uploads and draft sync before leaving.',
    ],
    instructions: [
      'New tickets accept up to 20 files, at most 10 MB each; sending allows 7 MB total. Review names and contents before sending.',
      'Saving a first message as a draft keeps attachments private with the unsent message. If uploading fails after creation, retry in the same form; successful uploads are kept.',
      'For an existing ticket, wait for reply uploads and draft sync to finish. Open an attachment preview to check it. A file in a draft has not been sent.',
    ],
    permissions: [
      'tickets.attach',
    ],
    anyPermissions: [
      'tickets.create',
      'tickets.reply',
    ],
  },
  {
    id: 'contacts',
    page: 'customers',
    target: 'customers',
    source: 'web/js/customers/index.js',
    title: 'Manage customer email addresses',
    body: 'Keep contact addresses accurate and check the primary email before replying.',
    highlights: [
      'Open the customer profile and review the email addresses.',
      'Use only contact actions allowed by your saved permissions.',
      'Check the primary address and the ticket recipient before sending.',
    ],
    instructions: [
      'Email actions depend on your saved permissions. Adding, choosing a primary email and removing an email are separate permissions.',
      'After an approved change, refresh the profile and verify that it was saved. An address may still be protected by validation or account rules. Read the error before retrying.',
    ],
    anyPermissions: [
      'customers.contact_add',
      'customers.contact_primary',
      'customers.contact_remove',
    ],
  },
  {
    id: 'assignment',
    page: 'tickets',
    target: 'tickets',
    source: 'web/js/tickets/list.js',
    title: 'Assign and check ownership',
    body: 'Choose the next owner and confirm the saved assignment.',
    highlights: [
      'Agree ownership using your team’s process.',
      'Choose the assigned agent in Details → Properties.',
      'Check the saved owner before leaving the ticket.',
    ],
    instructions: [
      'Open Details → Properties and change Assigned agent. Check availability and use your team’s escalation process.',
      'When another teammate or an assignment rule assigns a ticket, the assignee receives an email if Assignment emails is enabled. Assigning a ticket to yourself or keeping the same assignee does not send another email.',
      'An assignment alone does not explain the issue. Make sure the next owner has the context they need.',
    ],
    permissions: [
      'tickets.assign',
    ],
  },
  {
    id: 'preferences',
    page: 'settings',
    target: 'preferences',
    source: 'web/js/settings/index.js',
    title: 'Choose notification preferences',
    body: 'Review your profile, language and assignment email preferences.',
    highlights: [
      'Open Settings → Notifications to review Assignment emails.',
      'Choose the preference you want and wait for the save result.',
      'Assignment emails follow your saved preference across devices.',
    ],
    instructions: [
      'Review your profile and language preferences under Settings. Check the displayed save result when changing a preference.',
      'Under Settings → Appearance, choose Left or Top for the menu and Violet, Blue or Teal for your colour scheme. Choices preview immediately. Select Save changes to keep them across workspaces and devices. Cancel or leave Appearance to discard an unsaved preview. Restore defaults also needs Save changes. These choices affect only your account, not brand colours, the portal or emails.',
      'Under Notifications, Assignment emails controls emails when a teammate or assignment rule assigns a ticket to you. Self-assignment and an unchanged assignee do not send these emails.',
      'This guide does not change preferences. For practice you can inspect the current value without changing it.',
    ],
  },
  {
    id: 'configuration',
    page: 'config',
    target: 'configuration',
    source: 'web/js/config-hub/index.js',
    title: 'Review brand configuration',
    body: 'Find brand settings and understand what a saved change affects.',
    highlights: [
      'Open Configuration and choose the area you need.',
      'Review the current brand and settings before editing.',
      'Use a test workspace for changes approved by your team.',
    ],
    instructions: [
      'Configuration groups ticketing, content, channels and workspace settings. Available controls depend on your saved access.',
      'Ticket status choices control workflow categories, required reasons and survey rules. Closed choices never send surveys. Survey choices cannot recall a survey already sent.',
      'Review saved settings and the affected workflow before changing a live brand. This walkthrough changes nothing.',
    ],
    adminOnly: true,
  },
  {
    id: 'role-permissions',
    page: 'roles',
    target: 'roles',
    source: 'web/js/roles/index.js',
    title: 'Tailor role permissions',
    body: 'Review access for this brand and save only the changes you intend.',
    highlights: [
      'Open Permissions and scroll sideways to review more roles.',
      'Checkbox changes stay unsaved until Save changes.',
      'A new role opens the matrix and needs saving before assignment.',
    ],
    instructions: [
      'Brand Admins and God Users can tailor role permissions. Protected administrator access cannot be removed or assigned through a custom role.',
      'Choose + Role, name it and select Set permissions. Review its matrix column and choose Save changes. The role is unavailable for assignment until this save.',
      'Saved permissions take effect immediately; agents should refresh to see updated controls. If another administrator saved first, reload and review their settings before saving. Unsaved selections stay on screen after a failed save.',
    ],
    adminOnly: true,
  },
  {
    id: 'agent-admin',
    page: 'agents',
    target: 'agents',
    source: 'web/js/agents/index.js',
    title: 'Invite and manage agents',
    body: 'Check the recipient, access and invitation state before inviting a teammate.',
    highlights: [
      'Use Agents to review existing access before inviting.',
      'Choose only an approved role for the correct brand.',
      'Read the invite result before retrying.',
    ],
    instructions: [
      'Invite a teammate using the approved address and an available role. Existing protected Brand Admin access cannot be replaced through an invitation.',
      'Open an invited agent to resend an invitation, check the recipient, then confirm. An agent who has already joined has a password reset option instead.',
      'Ask the invitee to follow the emailed setup instructions. The guide does not send invitations or account emails.',
    ],
    permissions: [
      'admin.agents',
    ],
  },
];

export const GUIDE_MODULES = [
  {
    "id": "navigation",
    "title": "Find your way around",
    "body": "Workspace, queues and trusted guidance.",
    "stepIds": [
      "dashboard",
      "tickets",
      "review",
      "knowledge"
    ],
    "practice": [
      {
        "id": "workspace",
        "step": "dashboard",
        "task": "Check your workspace and open your team’s queue.",
        "expected": "The brand and queue match the work assigned to you."
      },
      {
        "id": "guidance",
        "step": "knowledge",
        "task": "Find an approved article for a sample issue.",
        "expected": "You can explain why its brand and scope fit the issue."
      }
    ]
  },
  {
    "id": "creation",
    "title": "Tickets, drafts and attachments",
    "body": "Start a conversation and prepare files.",
    "stepIds": [
      "create",
      "attachments"
    ],
    "practice": [
      {
        "id": "draft",
        "step": "create",
        "task": "Save an unsent ticket using a team-approved test contact.",
        "expected": "The saved draft reopens with the correct customer, inbox and subject."
      },
      {
        "id": "file",
        "step": "attachments",
        "task": "Add a harmless test file to an approved draft and reopen it.",
        "expected": "The file is available in the unsent draft and no email was sent."
      }
    ]
  },
  {
    "id": "replies",
    "title": "Reply, send and set status",
    "body": "Prepare a reply and check the outcome.",
    "stepIds": [
      "reply",
      "templates",
      "ai-review",
      "send",
      "statuses",
      "checklist"
    ],
    "practice": [
      {
        "id": "reply-draft",
        "step": "reply",
        "task": "Prepare and save a reply on an approved test ticket.",
        "expected": "The unsent reply has the correct recipient, language and facts."
      },
      {
        "id": "send-result",
        "step": "send",
        "task": "On a team-approved test ticket, choose the intended send action and check the result.",
        "expected": "The saved message and delivery notice confirm the send. If you chose a status action, the saved status matches it."
      },
      {
        "id": "status",
        "step": "statuses",
        "task": "Review the available status choices on an approved ticket.",
        "expected": "You can explain Open, Pending, Escalated, Resolved and Closed without changing live work."
      }
    ]
  },
  {
    "id": "customers",
    "title": "Understand customer profiles",
    "body": "Check history, identity and email addresses.",
    "stepIds": [
      "customers",
      "contacts"
    ],
    "practice": [
      {
        "id": "profile",
        "step": "customers",
        "task": "Open an approved customer profile and review related tickets.",
        "expected": "The customer and brand match, and you can identify related history."
      },
      {
        "id": "contact-check",
        "step": "contacts",
        "task": "Review available email controls and the primary address.",
        "expected": "You can identify your permitted actions and the correct recipient without deleting contact details."
      }
    ]
  },
  {
    "id": "handovers",
    "title": "Assignments and handovers",
    "body": "Find the right owner and leave useful context.",
    "stepIds": [
      "agents",
      "handover",
      "assignment"
    ],
    "practice": [
      {
        "id": "availability",
        "step": "agents",
        "task": "Find the teammate responsible for a sample escalation.",
        "expected": "You can identify the next owner using your team’s process."
      },
      {
        "id": "note",
        "step": "handover",
        "task": "Add an internal handover note to an approved test ticket.",
        "expected": "The note is internal and records checks, the next action and owner."
      },
      {
        "id": "owner",
        "step": "assignment",
        "task": "Assign an approved test ticket as agreed with your team.",
        "expected": "The saved assignee is correct; self-assignment does not trigger an assignment email."
      }
    ]
  },
  {
    "id": "preferences",
    "title": "Notifications and preferences",
    "body": "Understand the settings for your account.",
    "stepIds": [
      "preferences"
    ],
    "practice": [
      {
        "id": "notifications",
        "step": "preferences",
        "task": "Open Notifications and review Assignment emails.",
        "expected": "You know the saved preference and when an assignment email is expected."
      }
    ]
  },
  {
    "id": "administration",
    "title": "Brand administration",
    "body": "Review configuration, agent access and roles.",
    "stepIds": [
      "configuration",
      "role-permissions",
      "agent-admin"
    ],
    "practice": [
      {
        "id": "config",
        "step": "configuration",
        "task": "Find the brand’s ticket statuses and survey settings.",
        "expected": "You can explain the current rules without changing production settings."
      },
      {
        "id": "matrix",
        "step": "role-permissions",
        "task": "Inspect the permission matrix for an approved role.",
        "expected": "You can distinguish saved access from unsaved selections. New roles need Save changes before assignment."
      },
      {
        "id": "invite",
        "step": "agent-admin",
        "task": "Review an existing agent’s role and invitation state.",
        "expected": "You can identify whether an invite is pending without sending another email."
      }
    ]
  }
];

// Content changes invalidate viewed and self-confirmed practice progress.
export const GUIDE_VERSION = JSON.stringify([GUIDE_STEPS, GUIDE_MODULES]);

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
